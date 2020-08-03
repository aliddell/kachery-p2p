import { JSONStringifyDeterministic, verifySignature, hexToPublicKey, getSignature } from './common/crypto_util.js'
import dgram from 'dgram';
import { randomAlphaString, sleepMsec } from './common/util.js';
import { timeStamp } from 'console';

class InternalUdpServer {
    constructor(port) {
        this._onConnectionCallbacks = [];
        this._incomingConnections = {}; // by connection id
        this._outgoingConnections = {}; // by connection id
        this._pendingOutgoingConnections = {}; // by connection id
        this._publicEndpoint = null;
        this._publicEndpointChangedCallbacks = [];
        
        const socket = dgram.createSocket('udp4');
        if (port)
            socket.bind(port, '');
        else
            socket.bind();
        socket.on('listening', () => {
            // console.info('Udp socket', socket.address());
        });
        this._socket = socket;
        this._socket.on('message', (messageTxt, remote) => {
            // parse the json message
            let message;
            try {
                message = JSON.parse(messageTxt);
            }
            catch {
                console.warn('Unable to parse udp message', {remote});
                return;
            }

            this._handleIncomingMessage(message, remote);
        });

        this._start();
    }
    on(name, cb) {
        if (name === 'connection')
            this._onConnectionCallbacks.push(cb);
    }
    publicEndpoint() {
        return this._publicEndpoint;
    }
    onPublicEndpointChanged(cb) {
        this._publicEndpointChangedCallbacks.push(cb);
    }
    _createOutgoingUdpConnection({address, port}) {
        const connectionId = randomAlphaString(10);
        const C = new UdpConnection({udpServer: this, connectionId, remoteAddress: address, remotePort: port});
        C.on('close', () => {
            if (connectionId in this._pendingOutgoingConnections) {
                delete this._pendingOutgoingConnections[connectionId];
            }
            if (connectionId in this._outgoingConnections) {
                delete this._outgoingConnections[connectionId];
            }
        })
        this._pendingOutgoingConnections[connectionId] = C;
        const openMessage = {
            type: 'openConnection',
            connectionId
        };
        _udpSocketSend(this._socket, openMessage, port, address);
        return C;
    }
    _handleIncomingMessage(message, remote) {
        if ((message.type === 'openConnection') && (isValidConnectionId(message.connectionId))) {
            if (message.connectionId in this._incomingConnections) {
                console.warn(`openConnection: connection with id already exists: ${message.connectionId}`);
                return;
            }
            const C = new UdpConnection({
                udpServer: this,
                connectionId: message.connectionId,
                remoteAddress: remote.address,
                remotePort: remote.port
            });
            C.on('close', () => {
                if (this._incomingConnections[message.connectionId]) {
                    delete this._incomingConnections[message.connectionId];
                }
            });
            this._incomingConnections[message.connectionId] = C;
            const acceptMessage = {
                type: 'acceptConnection',
                connectionId: message.connectionId,
                initiatorPublicEndpoint: remote // the public endpoint of the initiator to the connection
            };
            _udpSocketSend(this._socket, acceptMessage, remote.port, remote.address);
            C._setOpen();
            this._onConnectionCallbacks.forEach(cb => {
                cb(C);
            });
        }
        else if ((message.type === 'acceptConnection') && (isValidConnectionId(message.connectionId))) {
            if (message.connectionId in this._pendingOutgoingConnections) {
                const C = this._pendingOutgoingConnections[message.connectionId];
                const ipe = message.initiatorPublicEndpoint;
                // make sure it really is a public endpoint
                if ((ipe) && (ipe.address) && (!ipe.address.startsWith('127.0.0')) && (!ipe.address.startsWith('0.')) && (C.remoteAddress() !== 'localhost')) {
                    if ((!this._publicEndpoint) || (JSONStringifyDeterministic(this._publicEndpoint) !== message.initiatorPublicEndpoint)) {
                        this._publicEndpoint = message.initiatorPublicEndpoint;
                        this._publicEndpointChangedCallbacks.forEach(cb => cb());
                    }
                }
                this._outgoingConnections[message.connectionId] = C
                delete this._pendingOutgoingConnections[message.connectionId];
                C._setOpen();
            }
        }
        else if (message.connectionId) {
            if (message.connectionId in this._incomingConnections) {
                this._incomingConnections[message.connectionId]._handleIncomingMessage(message.message);
            }
            else if (message.connectionId in this._outgoingConnections) {
                this._outgoingConnections[message.connectionId]._handleIncomingMessage(message.message);
            }
        }
        else {
            // don't do anything
        }
    }

    async _start() {
    }
}

class UdpConnection {
    constructor({udpServer, connectionId, remoteAddress, remotePort}) {
        this._udpServer = udpServer;
        this._connectionId = connectionId;
        this._remoteAddress = remoteAddress;
        this._remotePort = remotePort;
        this._open = false;
        this._closed = false;
        this._useUdp = true;

        this._queuedMessages = new Queue();
        this._priorityQueuedMessages = new Queue();
        this._unconfirmedMessages = {};
        this._numUnconfirmedMessages = 0;

        this._onOpenCallbacks = [];
        this._onCloseCallbacks = [];
        this._onErrorCallbacks = [];
        this._onMessageCallbacks = [];

        this._lastIncomingMessageTimestamp = new Date();
        this._lastOutgoingMessageTimestamp = new Date();

        this._handledIncomingUdpMessageIds = {};

        this._congestionManager = new UdpCongestionManager();
        this._handleQueuedMessagesScheduled = false;

        this._start();
    }
    on(name, cb) {
        if (name === 'open') {
            if (this._open) cb();
            this._onOpenCallbacks.push(cb);
        }
        else if (name === 'close') {
            this._onCloseCallbacks.push(cb);
        }
        else if (name === 'error') {
            this._onErrorCallbacks.push(cb);
        }
        else if (name === 'message') {
            this._onMessageCallbacks.push(cb);
        }
    }
    send(messageText) { // note: this message is text
        if (this._closed) return;

        const x = new Message(messageText);
        this._queuedMessages.enqueue(x);
        this._handleQueuedMessages();
    }
    _handleQueuedMessages() {
        while (true) {
            if (!this._open) return;
            if ((this._priorityQueuedMessages.isEmpty()) && (this._queuedMessages.isEmpty())) {
                return;
            }
            let numBytesNextMessage, delayMsec;
            if (!this._priorityQueuedMessages.isEmpty()) {
                numBytesNextMessage = this._priorityQueuedMessages[0].numBytes();
                delayMsec = this._congestionManager.estimateDelayForNextMessage(numBytesNextMessage);
                if (!delayMsec) {
                    this._sendQueuedMessage(this._priorityQueuedMessages.dequeue());
                }
            }
            else if (!this._queuedMessages.isEmpty()) {
                numBytesNextMessage = this._queuedMessages[0].numBytes();
                delayMsec = this._congestionManager.estimateDelayForNextMessage(numBytesNextMessage);
                if (!delayMsec) {
                    this._sendQueuedMessage(this._queuedMessages.dequeue());
                }
            }

            if (delayMsec) {
                // come back when we estimate we will be ready, if not already scheduled
                if (!this._handleQueuedMessagesScheduled) {
                    this._handleQueuedMessagesScheduled = true;
                    setTimeout(() => {
                        this._handleQueuedMessagesScheduled = false;
                        this._handleQueuedMessages();
                    }, delayMsec + 10);
                }
                return;
            }
        }
    }
    _sendQueuedMessage(x) {
        const message = {
            connectionId: this._connectionId,
            message: {
                type: 'message',
                udpMessageId: x.udpMessageId(),
                messageText: x.messageText()
            }
        };
        _udpSocketSend(this._udpServer._socket, message, this._remotePort, this._remoteAddress);
        x.setSentTimestamp(new Date());
        this._congestionManager.reportMessageSent({numBytes: x.numBytes(), udpMessageId: x.udpMessageId()});
        this._unconfirmedMessages[x.udpMessageId()] = x;
        this._numUnconfirmedMessages ++;
        setTimeout(() => {
            if (x.udpMessageId() in this._unconfirmedMessages) {
                if (x.numTries() >= 6) {
                    console.warn(`Udp message failed after ${x.numTries()} tries. Closing connection.`);
                    this.close();
                }
                x.incrementNumTries();
                this._priorityQueuedMessages.enqueue(x);
                delete this._unconfirmedMessages[x.udpMessageId()];
                this._congestionManager.reportMessageLost({udpMessageId: x.udpMessageId()});
            }
        }, this._congestionManager.estimatedRoundtripLatencyMsec() * 4);
    }
    close() {
        if (this._closed) return;
        const closeMessage = {
            connectionId: this._connectionId,
            message: {
                type: 'close'
            }
        };
        _udpSocketSend(this._udpServer._socket, closeMessage, this._remotePort, this._remoteAddress);
        this._closed = true;
        this._open = false;
        this._congestionManager.halt();
        this._onCloseCallbacks.forEach(cb => cb());
    }
    remoteAddress() {
        return this._remoteAddress;
    }
    remotePort() {
        return this._remotePort;
    }
    _handleIncomingMessage(message) {
        if (this._closed) return;

        this._lastIncomingMessageTimestamp = new Date();

        if (message.type === 'confirmUdpMessage') {
            this._handleConfirmUdpMessage(message.udpMessageId);
            return;
        }
        else if (message.type === 'close') {
            this.close();
            return;
        }
        else if (message.type === 'message') {
            if (!message.udpMessageId) {
                return;
            }
            const udpMessageId = message.udpMessageId;
            // Note: it's important to confirm receipt before checking if we already handled it
            // that's because maybe the confirmation was lost the last time
            const confirmMsg = {
                connectionId: this._connectionId,
                message: {
                    type: 'confirmUdpMessage',
                    udpMessageId
                }
            };
            _udpSocketSend(this._udpServer._socket, confirmMsg, this._remotePort, this._remoteAddress);

            if (udpMessageId in this._handledIncomingUdpMessageIds) {
                return;
            }
            this._handledIncomingUdpMessageIds[udpMessageId] = {timestamp: new Date()};

            if (message.messageText !== 'udpKeepAlive') {
                this._onMessageCallbacks.forEach(cb => cb(message.messageText));
            }
        }
        else {
            // ignore
        }
    }
    _handleConfirmUdpMessage(udpMessageId) {
        if (udpMessageId in this._unconfirmedMessages) {
            const m = this._unconfirmedMessages[udpMessageId];
            this._congestionManager.reportConfirmedMessage({numBytes: m.numBytes(), roundtripLatencyMsec: (new Date()) - m.sentTimestamp(), udpMessageId: m.udpMessageId()});
            delete this._unconfirmedMessages[udpMessageId];
            this._numUnconfirmedMessages --;
            if (this._thresh === 0) {
                this._maxNumUnconfirmedMessages ++;
                if (this._maxNumUnconfirmedMessages > 20) {
                    this._maxNumUnconfirmedMessages = 20;
                }
            }
            else {
                this._maxNumUnconfirmedMessages += 1/this._thresh;
            }
            this._handleQueuedMessages();
        }
    }
    _setOpen() {
        if (this._open) return;
        if (this._closed) return;
        this._open = true;
        this._onOpenCallbacks.forEach(cb => cb());
        this._handleQueuedMessages();
    }
    async _startCleanup() {
        while (true) {
            await sleepMsec(3000);
            // avoid memory leak
            for (let udpMessageId in this._handledIncomingUdpMessageIds) {
                const x = this._handledIncomingUdpMessageIds[udpMessageId];
                const elapsed = (new Date()) - x.timestamp;
                if (elapsed > 60000) {
                    delete this._handledIncomingUdpMessageIds[udpMessageId];
                }
            }
            if (this._closed) return;
        }
    }
    async _startKeepAlive() {
        const delayMsec = 1000;
        while (true) {
            if (this._closed) {
                return;
            }
            await sleepMsec(delayMsec);
            const elapsed1 = (new Date()) - this._lastOutgoingMessageTimestamp;
            if (elapsed1 > 5000) {
                if (this._open) {
                    this.send('udpKeepAlive');
                }
            }
            const elapsed2 = (new Date()) - this._lastIncomingMessageTimestamp;
            if (elapsed2 > 15000) {
                //console.warn(`Closing udp connection due to inactivity: ${this._connectionId}`);
                this.close();
            }
        }
    }
    
    async _start() {
        this._startKeepAlive();
        this._startCleanup();
    }
}

class Message {
    constructor(messageText) {
        this._messageText = messageText;
        this._numTries = 1;
        this._udpMessageId = randomAlphaString(10);
        this._sentTimestamp = null;
    }
    messageText() {
        return this._messageText;
    }
    numBytes() {
        return this._messageText.length;
    }
    numTries() {
        return this._numTries;
    }
    incrementNumTries() {
        this._numTries ++;
    }
    udpMessageId() {
        return this._udpMessageId;
    }
    setSentTimestamp(ts) {
        this._sentTimestamp = ts;
    }
    sentTimestamp() {
        return this._sentTimestamp;
    }
}

class UdpCongestionManager {
    constructor() {
        this._numUnconfirmedMessages = 0;
        this._numUnconfirmedBytes = 0;
        this._halt = false;

        this._maxNumBytesPerSecond = 1000000;
        this._estimatedRoundtripLatencyMsec = 500;

        this._trialDurationMsec = 5000;
        this._currentTrialData = null;
        this._resetTrialData();
        this._start();
    }

    reportMessageSent({numBytes, udpMessageId}) {
        this._currentTrialData.sentMessageIds[udpMessageId] = true;
        this._currentTrialData.numSentMessages ++;
        this._currentTrialData.numSentBytes += numBytes;
        if (this._currentTrialData.numSentBytes - this._currentTrialData.numConfirmedBytes > this._currentTrialData.peakNumUnconfirmedBytes) {
            this._currentTrialData.peakNumUnconfirmedBytes = this._currentTrialData.numSentBytes - this._currentTrialData.numConfirmedBytes;
        }
    }

    reportMessageLost({udpMessageId}) {
        if (!(udpMessageId in this._currentTrialData.sentMessageIds)) return;
        this._currentTrialData.numLostMessages ++;
    }

    reportConfirmedMessage({numBytes, roundtripLatencyMsec, udpMessageId}) {
        if (!(udpMessageId in this._currentTrialData.sentMessageIds)) return;
        this._currentTrialData.numConfirmedMessages ++;
        this._currentTrialData.numConfirmedBytes += numBytes;
        this._currentTrialData.roundtripLatenciesMsec.push(roundtripLatencyMsec);
    }

    estimatedRoundtripLatencyMsec() {
        return this._estimatedRoundtripLatencyMsec;
    }

    estimateDelayForNextMessage(numBytes) {
        const maxNumUnconfirmedBytes = this._maxNumBytesPerSecond / 1000 * this._estimatedRoundtripLatencyMsec;
        const numOutstandingBytes = this._currentTrialData.numSentBytes - this._currentTrialData.numConfirmedBytes;
        if (!numOutstandingBytes) return 0;
        if (numOutstandingBytes + numBytes <= maxNumUnconfirmedBytes) return 0;
        const diffBytes = numOutstandingBytes + numBytes - maxNumUnconfirmedBytes;
        const delayMsec = diffBytes / (this._maxNumBytesPerSecond / 1000);
        return delayMsec;
    }

    halt() {
        this._halt = true;
    }

    _resetTrialData() {
        this._currentTrialData = {
            sentMessageIds: {},
            numSentMessages: 0,
            numConfirmedMessages: 0,
            numLostMessages: 0,
            numSentBytes: 0,
            numConfirmedBytes: 0,
            roundtripLatenciesMsec: [],
            peakNumUnconfirmedBytes: 0
        }
    }
    _adjustCongestionParameters() {
        const d = this._currentTrialData;
        const debugUdp = false;
        let doPrint = ((debugUdp) && (d.numSentMessages > 10));
        if (this._currentTrialData.roundtripLatenciesMsec.length >= 3) {
            this._estimatedRoundtripLatencyMsec = (median(this._currentTrialData.roundtripLatenciesMsec) + this._estimatedRoundtripLatencyMsec) / 2;
            if (doPrint) console.info(`Estimated round-trip latency: ${this._estimatedRoundtripLatencyMsec}`)
            if (this._estimatedRoundtripLatencyMsec < 100) this._estimatedRoundtripLatencyMsec = 100;
            if (this._estimatedRoundtripLatencyMsec > 1000) this._estimatedRoundtripLatencyMsec = 1000;
        }
        if (d.numLostMessages === 0) {
            // didn't lose any messages... let's see if we were limited
            const a = this._maxNumBytesPerSecond / 1000 * this._estimatedRoundtripLatencyMsec;
            if (d.peakNumUnconfirmedBytes > 0.8 * a) {
                // okay, let's increae the rate
                this._maxNumBytesPerSecond *= 1.2;
            }
        }
        else if (d.numLostMessages === 1) {
            // lost a message. decrease the rate
            this._maxNumBytesPerSecond /= 1.1;
        }
        else if (d.numLostMessages >= 2) {
            // lost multiple messages, decrease the rate
            this._maxNumBytesPerSecond /= 1.2;
        }
        if (doPrint) console.info(`${d.numSentMessages} sent, ${d.numConfirmedMessages} confirmed, ${d.numLostMessages} lost, rate: ${this._maxNumBytesPerSecond / 1000000}, estLat: ${this._estimatedRoundtripLatencyMsec}`);
    }
    async _startTrials() {
        while (true) {
            this._resetTrialData();
            await sleepMsec(this._trialDurationMsec);
            this._adjustCongestionParameters();
            if (this._halt) return;
        }
    }
    async _start() {
        this._startTrials();
    }
}

function _udpSocketSend(socket, message, port, address) {
    const messageText = JSONStringifyDeterministic(message);
    socket.send(messageText, port, address, (err, numBytesSent) => {
        if (err) {
            console.warn('Failed to send udp message to remote', {address, port, error: err.message});
            return;
        }
        if (numBytesSent !== messageText.length) {
            console.warn('Problem sending udp message to remote: numBytesSent does not equal expected');
            return;
        }
    });
}

class Queue extends Array {
    enqueue(val) {
        this.push(val);
    }

    dequeue() {
        return this.shift();
    }

    peek() {
        return this[0];
    }

    isEmpty() {
        return this.length === 0;
    }
}

function isValidConnectionId(x) {
    if (!x) return false;
    if (typeof(x) !== 'string') return false;
    if (x.length < 10) return false;
    if (x.length > 20) return false;
    return true;
}

function median(x) {
    const values = [...x];
    values.sort(function (a, b) { return a - b; });
    var half = Math.floor(values.length / 2);
    if (values.length % 2)
        return values[half];
    else
        return (values[half - 1] + values[half]) / 2.0;
}

export default InternalUdpServer;