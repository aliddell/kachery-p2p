import crypto, { sign } from 'crypto';
import HyperswarmPeerConnection from './HyperswarmPeerConnection.js';
import { randomAlphaString, sleepMsec, randomString } from '../../common/util.js';
import { getSignature, verifySignature, publicKeyToHex, hexToPublicKey, JSONStringifyDeterministic } from '../../common/crypto_util.js';
import AbstractHyperswarm from './AbstractHyperswarm.js';
import { log } from '../../common/log.js';

class HyperswarmConnection {
    constructor({keyPair, nodeId, swarmName, protocolVersion}) {
        this._keyPair = keyPair; // The keypair for signing messages. Node id is the public key
        this._nodeId = nodeId; // The node id, determined by the public key
        this._protocolVersion = protocolVersion; // The protocol version we are using
        // check that public key is consistent with node id
        if (this._nodeId !== publicKeyToHex(this._keyPair.publicKey.toString('hex'))) {
            throw Error('public key not consistent with node ID.');
        }
        this._swarmName = swarmName; // name of the swarm
        const topicKey = { // the key used to compute the topic hash (for hyperswarm)
            protocolVersion,
            swarmName: swarmName
        };
        this._topic = crypto.createHash('sha256') // the topic hash (for hyperswarm)
            .update(JSONStringifyDeterministic(topicKey))
            .digest()
        this._topicHex = crypto.createHash('sha256') // the hex version
            .update(JSONStringifyDeterministic(topicKey))
            .digest('hex');
        this._hyperswarm = null; // the hyperswarm object
        this._peerConnections = {}; // connections to direct peers

        // todo: we have a memory leak here... clean up the old message ids
        this._messageIdsHandled = {}; // ids of messages already handled (so we don't handle them twice)
        this._onMessageCallbacks = []; // callbacks for when a message is received
        this._onPeerConnectionCallbacks = []; // callbacks for when a new peer is connected
        this._messageListeners = {}; // listeners for messages from peers

        // check the event listeners
        this.onMessage((fromNodeId, msg) => {
            // check all the message listeners
            for (let id in this._messageListeners) {
                const x = this._messageListeners[id];
                if (x.testFunction(fromNodeId, msg)) {
                    x.onMessageCallbacks.forEach(cb => {cb(fromNodeId, msg);});
                }
            }
        });

        // start the loop
        this._start();
    }
    // join the swarm by creating a hyperswarm object
    async join() {
        log('discovery').info(`HYPERSWARM:: joining hyperswarm`, {swarmName: this._swarmName, topicHex: this._topicHex});
        this._hyperswarm = new AbstractHyperswarm(this._topic);
        
        this._hyperswarm.onConnection((jsonSocket, socket, details) => {
            // a new hyperswarm connection
            this._handleNewConnection({jsonSocket, socket, details});
        });
    }
    // return whether a peer is local
    peerIsLocal(peerId) {
        if (peerId in this._peerConnections) {
            return this._peerConnections[peerId].peerIsLocal();
        }
        return null;
    }
    _handleNewConnection({jsonSocket, socket, details}) {
        // todo: provide an AbstractHyperswarmConnection here
        // *** then implement the hub connection
        log('discovery').info('HYPERSWARM:: new incoming connection');
        // Send a special initial message to make sure we have the node id and the protocol version
        const initialBody = {
            type: 'initial',
            from: details.client ? 'server' : 'client',
            nodeId: this._nodeId,
            protocolVersion: this._protocolVersion
        };
        const initialSignature = getSignature(initialBody, this._keyPair);
        jsonSocket.sendMessage({
            body: initialBody,
            signature: initialSignature
        });
        let receivedInitialMessage = false;
        jsonSocket.on('message', msg => {
            // safe
            if (receivedInitialMessage) return;
            receivedInitialMessage = true;
            if (!msg.body) {
                log('discovery').warning('HYPERSWARM:: Unexpected initial message from peer connection. No body. Closing socket.');
                socket.destroy();
                return;
            }
            if (msg.body.type !== 'initial') {
                log('discovery').warning('HYPERSWARM:: Unexpected initial message from peer connection. Closing socket.');
                socket.destroy();
                return;
            }
            if (msg.body.protocolVersion !== this._protocolVersion) {
                log('discovery').warning(`HYPERSWARM:: Incorrect protocol version from peer connection. Closing socket.`, {messageProtocolVersion: msg.body.protocolVersion, protocolVersion: this._protocolVersion});
                socket.destroy();
                return;
            }
            if (!validatePeerNodeId(msg.body.nodeId)) {
                log('discovery').warning('HYPERSWARM:: Missing or incorrect node ID from peer connection. Closing socket.');
                socket.destroy();
                return;
            }
            if (!verifySignature(msg.body, msg.signature, hexToPublicKey(msg.body.nodeId))) {
                log('discovery').warning('HYPERSWARM:: Unable to verify signature in initial message. Closing socket.');
                socket.destroy();
                return;
            }
            if (msg.body.from !== (details.client ? 'client' : 'server')) {
                log('discovery').warning('HYPERSWARM:: Unexpected "from" value from peer connection. Closing socket.');
                socket.destroy();
                return;
            }
            log('discovery').info(`HYPERSWARM:: new incoming connection`, {nodeId: msg.body.nodeId});
            if (!this._peerConnections[msg.body.nodeId]) {
                let peerConnection;
                try {
                    peerConnection = new HyperswarmPeerConnection({
                        keyPair: this._keyPair,
                        nodeId: this._nodeId,
                        swarmName: this._swarmName,
                        peerId: msg.body.nodeId
                    });
                }
                catch(err) {
                    log('discovery').warning('HYPERSWARM:: Problem creating peer connection. Closing socket.', {error: err.message});
                    socket.destroy();
                    return;
                }
                this._peerConnections[msg.body.nodeId] = peerConnection;
                this._onPeerConnectionCallbacks.forEach(cb => cb(msg.body.nodeId));
                peerConnection.onSignedMessage((msg2, details) => {
                    const fromNodeId = msg2.body.fromNodeId;
                    if (!verifySignature(msg2.body, msg2.signature, hexToPublicKey(fromNodeId))) {
                        log('discovery').warning('HYPERSWARM:: Problem verifying signature. Closing socket.', {fromNodeId});
                        socket.destroy();
                        return;
                    }
                    const messageId = msg2.body.messageId;
                    if (this._messageIdsHandled[messageId]) {
                        // already handled
                        return;
                    }
                    this._messageIdsHandled[messageId] = true;
                    if ((msg2.body.toNodeId === this._nodeId) || (msg2.body.toNodeId === 'all')) {
                        try {
                            this._handleMessageFromNode(fromNodeId, deepCopy(msg2.body.message));
                        }
                        catch(err) {
                            log('discovery').warning('HYPERSWARM:: Problem handling message from peer. Closing socket.', {error: err.message});
                            socket.destroy();
                        }
                    }
                    if (msg2.broadcast) {
                        this._broadcastSignedMessage({
                            body: msg2.body,
                            broadcast: true,
                            signature: msg2.signature,
                            excludeNodeIds: msg2.excludeNodeIds || {}
                        });
                    }
                });
            }
            if (details.client) {
                try {
                    this._peerConnections[msg.body.nodeId].setOutgoingSocket(jsonSocket);
                }
                catch(err) {
                    log('discovery').warning('HYPERSWARM:: Problem setting outgoing socket. Closing socket.', {error: err.mesage});
                    socket.destroy();
                }
            }
            else {
                try {
                    this._peerConnections[msg.body.nodeId].setIncomingSocket(jsonSocket);
                }
                catch(err) {
                    log('discovery').warning('HYPERSWARM:: Problem setting incoming socket. Closing socket.', {error: err.mesage});
                    socket.destroy();
                }
            }
            if (details.peer) {
                const peer = details.peer;
                log('discovery').info(`HYPERSWARM:: Connected to peer`, {host: peer.host, port: peer.port, local: peer.local, nodeId: msg.body.nodeId});
                try {
                    this._peerConnections[msg.body.nodeId].setConnectionInfo({
                        host: details.peer.host,
                        port: details.peer.port,
                        local: details.peer.local
                    });
                }
                catch(err) {
                    log('discovery').warning('HYPERSWARM:: Problem setting connection info. Closing socket.', {error: err.message});
                    socket.destroy();
                }
                // this.printInfo();
            }
            socket.on('error', (err) => {
                log('discovery').warning('HYPERSWARM:: Socket error. Closing socket.', {error: err.message});
                socket.destroy();
            });
            socket.on('close', () => {
                // safe
                if (msg.body.nodeId in this._peerConnections) {
                    const peerInfo = this._peerConnections[msg.body.nodeId].connectionInfo();
                    log('discovery').info(`HYPERSWARM:: Socket closed for peer connection`, {peerInfo, nodeId: msg.body.nodeId});
                    this._peerConnections[msg.body.nodeId].disconnect();
                    delete this._peerConnections[msg.body.nodeId];
                    // this.printInfo();
                }
            })
        });
    }
    async leave() {
        this._hyperswarm.leave();
    }
    onPeerConnection(cb) {
        this._onPeerConnectionCallbacks.push(cb);
    }
    peerIds() {
        return Object.keys(this._peerConnections);
    }
    peerConnection(peerId) {
        return this._peerConnections[peerId];
    }
    numPeers() {
        return Object.keys(this._peerConnections).length;
    }
    disconnectPeer(peerId) {
        if (!(peerId in this._peerConnections)) {
            log('discovery').warning(`HYPERSWARM:: Cannot disconnect from peer. Not connected.`, {peerId});
            return;
        }
        this._peerConnections[peerId].disconnect();
        delete this._peerConnections[peerId];
    }
    printInfo() {
        const numPeers = this.numPeers();
        console.info(`HYPERSWARM:: ${numPeers} ${numPeers === 1 ? "peer" : "peers"}`);
    }
    sendMessageToNode(toNodeId, messageBody, opts) {
        const body = {
            messageId: randomAlphaString(10),
            fromNodeId: this._nodeId,
            toNodeId,
            message: messageBody
        }
        const signature = getSignature(body, this._keyPair);
        const signedMessage = {
            body,
            signature
        };
        if (toNodeId in this._peerConnections) {
            this._peerConnections[toNodeId].sendSignedMessage(signedMessage);
        }
        else {
            this._broadcastSignedMessage(signedMessage);
        }
    }
    sendMessageToAllNodes = (message) => {
        const body = {
            fromNodeId: this._nodeId,
            toNodeId: 'all',
            messageId: randomString(10),
            message
        };
        const signature = getSignature(body, this._keyPair);
        const signedMessage = {
            body,
            broadcast: true,
            signature,
            excludeNodeIds: {[this._nodeId]: true}
        }
        this._broadcastSignedMessage(signedMessage);
    }
    _broadcastSignedMessage = (signedMessage) => {
        const excludeNodeIds = signedMessage.excludeNodeIds || {};
        const peerIds = Object.keys(this._peerConnections);
        peerIds.forEach(peerId => {
            if (!excludeNodeIds[peerId]) {
                this._peerConnections[peerId].sendSignedMessage({
                    body: signedMessage.body,
                    broadcast: true,
                    signature: signedMessage.signature,
                    excludeNodeIds: {...excludeNodeIds, [this._nodeId]: true}
                });
            }
        })
    }
    onMessage = cb => {
        this._onMessageCallbacks.push(cb);
    }
    createPeerMessageListener = (testFunction, opts) => {
        opts = opts || {};
        const x = {
            name: opts.name || randomAlphaString(10),
            testFunction,
            onMessageCallbacks: []
        };
        this._messageListeners[x.name] = x;
        return {
            onMessage: cb => {x.onMessageCallbacks.push(cb);},
            cancel: () => {
                delete this._messageListeners[x.name]
            }
        };
    }
    _handleMessageFromNode = (fromNodeId, msg) => {
        for (let cb of this._onMessageCallbacks) {
            cb(fromNodeId, msg);
        }
    }

    async _start() {
        while (true) {
            const peerIds = this.peerIds();
            for (let peerId of peerIds) {
                const peerConnection = this._peerConnections[peerId];
                if (peerConnection.elapsedTimeSecSinceLastIncomingMessage() > 20) {
                    this.disconnectPeer(peerId);
                }
                if (peerConnection.elapsedTimeSecSinceLastOutgoingMessage() > 5) {
                    peerConnection.sendMessage({type: 'keepAlive'});
                }
            }

            await sleepMsec(100);
        }
    }
}

function deepCopy(x) {
    return JSON.parse(JSON.stringify(x));
}

// safe
const validatePeerNodeId = (nodeId) => {
    return ((nodeId) && (typeof(nodeId) == 'string') && (nodeId.length <= 256));
}

export default HyperswarmConnection;