import WebSocket from 'ws';
import { JSONStringifyDeterministic, verifySignature, hexToPublicKey, getSignature } from '../common/crypto_util.js'
import { protocolVersion } from './protocolVersion.js';
import InternalUdpServer from './InternalUdpServer.js';

// todo: monitor and clean up closed connections throughout file

class WebsocketServer {
    constructor({nodeId, keyPair, useUdp=false}) {
        this._nodeId = nodeId;
        this._keyPair = keyPair;
        this._useUdp = useUdp;
        this._websocketServer = null; // or InternaludpServer
        this._onIncomingConnectionCallbacks = [];
        this._udpPublicEndpointChangedCallbacks = [];
    }
    onIncomingConnection = (cb) => {
        this._onIncomingConnectionCallbacks.push(cb);
    }
    async listen(port) {
        ///////////////////////////////////////////////////////////////////////////////
        if (!this._useUdp) {
            this._websocketServer = new WebSocket.Server({ port });
        }
        else {
            this._websocketServer = new InternalUdpServer({ port });
            this._websocketServer.onPublicEndpointChanged(() => {
                this._udpPublicEndpointChangedCallbacks.forEach(cb => cb());
            })
        }
        this._websocketServer.on('connection', (ws) => {
            let X = new IncomingWebsocketConnection(ws, {nodeId: this._nodeId, keyPair: this._keyPair});
            X.onInitialized(() => {
                this._onIncomingConnectionCallbacks.forEach(cb => {
                    cb(X);
                });
            });
        });
        ///////////////////////////////////////////////////////////////////////////////
    }
    udpPublicEndpoint() {
        if (!this._useUdp) return null;
        if (this._websocketServer) {
            return this._websocketServer.publicEndpoint();
        }
        else {
            return null;
        }
    }
    onUdpPublicEndpointChanged(cb) {
        this._udpPublicEndpointChangedCallbacks.push(cb);
    }
    async createOutgoingConnection({address, port, remoteNodeId}) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const X = new OutgoingConnection({
                address,
                port,
                nodeId: this._nodeId,
                keyPair: this._keyPair,
                remoteNodeId,
                useUdp: this._useUdp,
                udpServer: this._useUdp ? this._websocketServer : null
            });
            X.onConnect(() => {
                if (finished) return;
                finished = true;
                resolve(X);
            });
            X.onError((error) => {
                if (finished) return;
                finished = true;
                reject(error);
            });
            X.onDisconnect(() => {
                if (finished) return;
                finished = true;
                reject(new Error('Outgoing connection disconnected.'));
            });
        });
    }
}

class IncomingWebsocketConnection {
    constructor(webSocket, {nodeId, keyPair}) {
        this._nodeId = nodeId;
        this._keyPair = keyPair;
        this._webSocket = webSocket;
        this._onMessageCallbacks = [];
        this._onDisconnectCallbacks = [];
        this._onInitializedCallbacks = [];
        this._remoteNodeId = null;
        this._initialized = false;

        this._webSocket.on('close', () => {
            this._onDisconnectCallbacks.forEach(cb => cb());
        })

        this._webSocket.on('error', () => {
            // this is important so we don't throw an exception
            // question: do we need to do something here? will 'close' be called also?
        });

        this._webSocket.on('message', (message) => {
            let msg;
            if (this._webSocket._useUdp) {
                msg = message;
            }
            else {
                msg = JSON.parse(message);
            }
            const body = msg.body;
            const signature = msg.signature;
            if (!body.message) {
                this._webSocket.close();
                return;
            }
            if (!this._initialized) {
                if (!body.fromNodeId) {
                    console.warn('IncomingSocketConnection: missing fromNodeId');
                    this._webSocket.close();
                    return;
                }
                if (body.message.type !== 'initial') {
                    console.warn(`IncomingSocketConnection: message type was expected to be initial, but got ${body.message.type}`);
                    this._webSocket.close();
                    return;
                }
                if (body.message.protocolVersion !== protocolVersion()) {
                    console.warn(`IncomingSocketConnection: incorrect protocl version ${body.message.protocolVersion} <> ${protocolVersion()}`);
                    this._webSocket.close();
                    return;
                }
                if (!verifySignature(body, signature, hexToPublicKey(body.fromNodeId))) {
                    console.warn(`IncomingSocketConnection: problem verifying signature`);
                    this._webSocket.close();
                    return;
                }
                this._remoteNodeId = body.fromNodeId;
                this._initialized = true;
                this._onInitializedCallbacks.forEach(cb => cb());
                this.sendMessage({type: 'accepted'});
                return;
            }

            if (body.fromNodeId !== this._remoteNodeId) {
                this._webSocket.close();
                return;
            }
            if (!verifySignature(body, signature, hexToPublicKey(this._remoteNodeId))) {
                this._webSocket.close();
                return;
            }
            this._onMessageCallbacks.forEach(cb => {
                cb(msg.body.message);
            });
        });
    }
    onInitialized(cb) {
        this._onInitializedCallbacks.push(cb);
    }
    remoteNodeId() {
        return this._remoteNodeId;
    }
    onMessage(cb) {
        this._onMessageCallbacks.push(cb);
    }
    onDisconnect(cb) {
        this._onDisconnectCallbacks.push(cb);
    }
    sendMessage(msg) {
        const body = {
            fromNodeId: this._nodeId,
            message: msg
        }
        const message = {
            body,
            signature: getSignature(body, this._keyPair)
        };
        this._webSocket.send(JSONStringifyDeterministic(message));
    }
    disconnect() {
        this._webSocket.close();
    }
}

class OutgoingConnection {
    constructor({ address, port, nodeId, keyPair, remoteNodeId, useUdp=false, udpServer=null }) {
        this._nodeId = nodeId;
        this._keyPair = keyPair;
        this._remoteNodeId = remoteNodeId;
        this._useUdp = useUdp;
        this._address = address;
        this._port = port;
        this._queuedMessages = [];
        this._onMessageCallbacks = [];
        this._onConnectCallbacks = [];
        this._onErrorCallbacks = [];
        this._onDisconnectCallbacks = [];
        this._isOpen = false;
        this._isClosed = false;
        this._accepted = false;

        if (!this._useUdp) {
            this._ws = new WebSocket(`ws://${this._address}:${this._port}`);
        }
        else {
            this._ws = udpServer._createOutgoingUdpConnection({address: this._address, port: this._port});
        }

        this._ws.on('open', () => {
            if (this._isOpen) return;
            this._isOpen = true;
            this._sendQueuedMessages();
        });

        this._ws.on('close', () => {
            if (this._isClosed) return;
            this._isClosed = true;
            this._onDisconnectCallbacks.forEach(cb => cb());
        });

        this._ws.on('error', (err) => {
            this._onErrorCallbacks.forEach(cb => cb(err));
            // this is important so we don't throw an exception
            // question: do we need to do something here? will 'close' be called also?
        });

        this._ws.on('message', msg => {
            const message = JSON.parse(msg);
            const body = message.body;
            const signature = message.signature;
            if ((!body) || (!signature)) {
                console.warn('OutgoingSocketConnection: Missing body or signature in message');
                this.disconnect();
                return;
            }
            const message2 = message.body.message;
            const fromNodeId = message.body.fromNodeId;
            if (!message2) {
                console.warn('OutgoingSocketConnection: Missing message in body');
                this.disconnect();
                return;
            }
            if (this._remoteNodeId) {
                if (fromNodeId !== this._remoteNodeId) {
                    console.warn('OutgoingSocketConnection: Mismatch in fromNodeId/remoteNodeId');
                    this.disconnect();
                    return;
                }
            }
            else {
                this._remoteNodeId = fromNodeId;
            }            this._
            if (!verifySignature(body, signature, hexToPublicKey(fromNodeId))) {
                console.warn('OutgoingSocketConnection: Problem verifying signature');
                this.disconnect();
                return;
            }
            if (!this._accepted) {
                if (message2.type === 'accepted') {
                    this._accepted = true;
                    this._onConnectCallbacks.forEach(cb => cb());
                    return;
                }
            }
            this._onMessageCallbacks.forEach(cb => {
                cb(message2);
            });
        });
        this.sendMessage({
            type: 'initial',
            protocolVersion: protocolVersion()
        });
        setTimeout(() => {
            if (!this._accepted) {
                if (!this._isClosed) {
                    this.disconnect();
                }
            }
        }, 5000);
    }
    remoteNodeId() {
        return this._remoteNodeId;
    }
    disconnect() {
        this._ws.close();
    }
    onConnect(cb) {
        this._onConnectCallbacks.push(cb);
    }
    onError(cb) {
        this._onErrorCallbacks.push(cb);
    }
    onMessage(cb) {
        this._onMessageCallbacks.push(cb);
    }
    onDisconnect(cb) {
        this._onDisconnectCallbacks.push(cb);
    }
    sendMessage(msg) {
        if (this._isOpen) {
            if (this._isClosed) {
                // log().warning('Cannot send message. Websocket is closed.', {address: this._address, port: this._port});
                return;
            }
            const body = {
                fromNodeId: this._nodeId,
                message: msg
            };
            const message = {
                body,
                signature: getSignature(body, this._keyPair)
            };
            this._ws.send(JSONStringifyDeterministic(message));
        }
        else {
            this._queuedMessages.push(msg);
        }
    }
    _sendQueuedMessages() {
        const qm = this._queuedMessages;
        this._queuedMessages = [];
        qm.forEach(msg => {
            this.sendMessage(msg);
        });
    }
}

export default WebsocketServer;