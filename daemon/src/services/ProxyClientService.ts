import { action } from "../common/action";
import DataStreamy from "../common/DataStreamy";
import GarbageMap from '../common/GarbageMap';
import { sleepMsec } from "../common/util";
import { WebSocketInterface } from "../external/ExternalInterface";
import { Address, elapsedSince, KeyPair, NodeId, nowTimestamp, Timestamp, zeroTimestamp } from "../interfaces/core";
import { NodeToNodeRequest, NodeToNodeResponse, StreamId } from "../interfaces/NodeToNodeRequest";
import { ProxyConnectionToServer } from "../proxyConnections/ProxyConnectionToServer";
import { DurationMsec, durationMsec, durationMsecToNumber } from "../udp/UdpCongestionManager";

interface RemoteNodeManagerInterface {
    getAllRemoteNodes: () => RemoteNodeInterface[]
    getRemoteNode: (remoteNodeId: NodeId) => RemoteNodeInterface | null
}

interface RemoteNodeInterface {
    remoteNodeId: () => NodeId
    getRemoteNodeWebSocketAddress: () => Address | null
}

interface KacheryP2PNodeInterface {
    remoteNodeManager: () => RemoteNodeManagerInterface
    nodeId: () => NodeId
    keyPair: () => KeyPair
    handleNodeToNodeRequest: (request: NodeToNodeRequest) => Promise<NodeToNodeResponse>
    streamFileData: (nodeId: NodeId, streamId: StreamId) => DataStreamy
    getProxyConnectionToServer: (remoteNodeId: NodeId) => ProxyConnectionToServer | null
    setProxyConnectionToServer: (nodeId: NodeId, c: ProxyConnectionToServer) => void
    createWebSocket: (url: string, opts: {timeoutMsec: DurationMsec}) => WebSocketInterface
}

export default class ProxyClientService {
    #node: KacheryP2PNodeInterface
    #remoteNodeManager: RemoteNodeManagerInterface
    #proxyClientManager: ProxyClientManager
    #halted = false
    constructor(node: KacheryP2PNodeInterface, private opts: {intervalMsec: DurationMsec}) {
        this.#node = node
        this.#remoteNodeManager = node.remoteNodeManager()
        this.#proxyClientManager = new ProxyClientManager(this.#node)
        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _start() {
        // periodically try to establish proxy connections to the remote nodes
        while (true) {
            if (this.#halted) return
            const remoteNodes = this.#remoteNodeManager.getAllRemoteNodes()
            for (let remoteNode of remoteNodes) {
                if (remoteNode.getRemoteNodeWebSocketAddress()) {
                    const remoteNodeId = remoteNode.remoteNodeId()
                    const c = this.#node.getProxyConnectionToServer(remoteNodeId)
                    if (!c) {
                        const elapsedMsec = this.#proxyClientManager.elapsedMsecSinceLastFailedOutgoingConnection(remoteNodeId)
                        if (elapsedMsec > 15000) {
                            /////////////////////////////////////////////////////////////////////////
                            await action('tryOutgoingProxyConnection', {context: 'ProxyClientService', remoteNodeId}, async () => {
                                await this.#proxyClientManager.tryConnection(remoteNodeId, {timeoutMsec: durationMsec(3000)});
                            }, null)
                            /////////////////////////////////////////////////////////////////////////
                        }
                    }
                }
            }
            await sleepMsec(durationMsecToNumber(this.opts.intervalMsec), () => {return !this.#halted})
        }
    }
}

class ProxyClientManager {
    #node: KacheryP2PNodeInterface
    // #outgoingConnections = new Map<NodeId, ProxyConnectionToServer>()
    #failedConnectionAttemptTimestamps = new GarbageMap<NodeId, Timestamp>(durationMsec(120000))
    constructor(node: KacheryP2PNodeInterface) {
        this.#node = node
    }
    async tryConnection(remoteNodeId: NodeId, opts: {timeoutMsec: DurationMsec}) {
        const remoteNode = this.#node.remoteNodeManager().getRemoteNode(remoteNodeId)
        if (!remoteNode) return
        const webSocketAddress = remoteNode.getRemoteNodeWebSocketAddress();
        if (!webSocketAddress) {
            return;
        }
        try {
            const c = new ProxyConnectionToServer(this.#node);
            await c.initialize(remoteNodeId, webSocketAddress, {timeoutMsec: opts.timeoutMsec});
            this.#node.setProxyConnectionToServer(remoteNodeId, c)
        }
        catch(err) {
            this.#failedConnectionAttemptTimestamps.set(remoteNodeId, nowTimestamp())
            throw(err);
        }
    }
    elapsedMsecSinceLastFailedOutgoingConnection(remoteNodeId: NodeId): number {
        const timestamp: Timestamp = this.#failedConnectionAttemptTimestamps.get(remoteNodeId) || zeroTimestamp()
        return elapsedSince(timestamp)
    }
    getConnection(remoteNodeId: NodeId): ProxyConnectionToServer | null {
        return this.#node.getProxyConnectionToServer(remoteNodeId)
    }
}