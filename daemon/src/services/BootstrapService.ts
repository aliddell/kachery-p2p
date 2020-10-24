import { action } from "../common/action";
import { sleepMsec, sleepMsecNum } from "../common/util";
import { Address, DurationMsec, JSONObject, NodeId, scaledDurationMsec, urlPath, UrlPath } from "../interfaces/core";
import KacheryP2PNode from "../KacheryP2PNode";
import { isApiProbeResponse } from "../services/PublicApiServer";

interface RemoteNodeManagerInterface {
    setBootstrapNode: (remoteNodeId: NodeId, address: Address, webSocketAddress: Address | null, publicUdpSocketAddress: Address | null) => void
}

interface RemoteNodeInterface {
}

interface KacheryP2PNodeInterface {
    remoteNodeManager: () => RemoteNodeManagerInterface
    bootstrapAddresses: () => Address[]
    httpPostJsonFunction: () => ((address: Address, path: UrlPath, data: Object, opts: {timeoutMsec: DurationMsec}) => Promise<JSONObject>)
}

export type HttpPostJson = (address: Address, path: UrlPath, data: JSONObject, opts: {timeoutMsec: DurationMsec}) => Promise<JSONObject>

export default class BootstrapService {
    #node: KacheryP2PNode
    #remoteNodeManager: RemoteNodeManagerInterface
    #halted = false
    constructor(node: KacheryP2PNode, private opts: {probeIntervalMsec: DurationMsec}) {
        this.#node = node
        this.#remoteNodeManager = node.remoteNodeManager()
        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _probeBootstrapNode(address: Address) {
        const response = await this.#node.externalInterface().httpPostJson(address, urlPath('/probe'), {}, {timeoutMsec: scaledDurationMsec(2000)});
        if (!isApiProbeResponse(response)) {
            throw Error('Invalid probe response from bootstrap node.')
        }
        const {nodeId: remoteNodeId, isBootstrapNode, webSocketAddress} = response
        if (!isBootstrapNode) {
            throw Error('isBootstrapNode is false in probe response from bootstrap node.')
        }
        const publicUdpSocketAddress = response.publicUdpSocketAddress
        this.#remoteNodeManager.setBootstrapNode(remoteNodeId, address, webSocketAddress, publicUdpSocketAddress)
    }
    async _start() {
        await sleepMsecNum(2) // important for tests
        // probe the bootstrap nodes periodically
        while (true) {
            if (this.#halted) return
            for (let address of this.#node.bootstrapAddresses()) {

                /////////////////////////////////////////////////////////////////////////
                await action('probeBootstrapNode', {context: 'BootstrapService', address}, async () => {
                    await this._probeBootstrapNode(address)
                }, null)
                /////////////////////////////////////////////////////////////////////////
                
            }
            
            await sleepMsec(this.opts.probeIntervalMsec, () => {return !this.#halted})
        }
    }
}