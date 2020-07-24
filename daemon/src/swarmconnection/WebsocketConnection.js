import WebSocket from 'ws';
import { JSONStringifyDeterministic } from '../common/crypto_util.js';
import { log } from '../common/log.js';

class WebsocketConnection {
    constructor({ host, port }) {
        this._host = host;
        this._port = port;
        this._queuedMessages = [];
        this._onMessageCallbacks = [];
        this._onConnectCallbacks = [];
        this._onErrorCallbacks = [];
        this._onDisconnectCallbacks = [];
        this._isOpen = false;
        this._isClosed = false;
        this._ws = new WebSocket(`ws://${this._host}:${this._port}`);

        this._ws.on('open', () => {
            this._isOpen = true;
            this._onConnectCallbacks.forEach(cb => cb());
            this._sendQueuedMessages();
        });

        this._ws.on('close', () => {
            this._isClosed = true;
            this._onDisconnectCallbacks.forEach(cb => cb());
        });

        this._ws.on('error', () => {
            this._onErrorCallbacks.forEach(cb => cb());
            // this is important so we don't throw an exception
            // question: do we need to do something here? will 'close' be called also?
        });

        this._ws.on('message', msg => {
            const message = JSON.parse(msg);
            this._onMessageCallbacks.forEach(cb => {
                cb(message);
            });
        });
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
                log().warning('Cannot send message. Websocket is closed.', {host: this._host, port: this._port});
                return;
            }
            this._ws.send(JSONStringifyDeterministic(msg));
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

export default WebsocketConnection;