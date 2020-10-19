import crypto from 'crypto'
import DataStreamy from "../../common/DataStreamy"
import { byteCount, ByteCount, byteCountToNumber, FileKey, FileManifest, FileManifestChunk, Sha1Hash } from "../../interfaces/core"

export default class MockKacheryStorageManager {
    #mockFiles = new Map<Sha1Hash, Buffer>() 
    async findFile(fileKey: FileKey):  Promise<{found: boolean, size: ByteCount}> {
        const content = this.#mockFiles.get(fileKey.sha1)
        if (content) {
            return {
                found: true,
                size: byteCount(content.length)
            }
        }
        else {
            return {
                found: false,
                size: byteCount(0)
            }
        }
    }
    async getFileReadStream(fileKey: FileKey): Promise<DataStreamy> {
        const content = this.#mockFiles.get(fileKey.sha1)
        if (content) {
            const ret = new DataStreamy()
            setTimeout(() => {
                ret._start(byteCount(content.length))
                ret._data(content)
                ret._end()
            }, 2)
            return ret
        }
        else {
            throw Error(`File not found: ${fileKey.sha1}`)
        }
    }
    async storeFile(sha1: Sha1Hash, data: Buffer) {
        const fileKey = this.addMockFile(data, {chunkSize: byteCount(data.length)})
        if (fileKey.sha1 !== sha1) {
            throw Error(`Unexpected hash for storing file: ${fileKey.sha1} <> ${sha1}`)
        }
    }
    async concatenateChunks(sha1Concat: Sha1Hash, chunkSha1s: Sha1Hash[]): Promise<void> {
        const chunks: Buffer[] = []
        chunkSha1s.forEach(sha1 => {
            const content = this.#mockFiles.get(sha1)
            if (content) {
                chunks.push(content)
            }
            else {
                throw Error('Unable to find chunk in mock kachery storage')
            }
        })
        const buf = Buffer.concat(chunks)
        this.storeFile(sha1Concat, buf)
    }
    addMockFile(content: Buffer, opts: {chunkSize: ByteCount}): FileKey {
        const shasum = crypto.createHash('sha1')
        shasum.update(content)
        const sha1 = shasum.digest('hex') as any as Sha1Hash
        if (content.length > byteCountToNumber(opts.chunkSize)) {
            const manifest: FileManifest = this._createFileManifest(content, opts.chunkSize)
            const manifestContent = Buffer.from(JSON.stringify(manifest))
            const manifestKey = this.addMockFile(manifestContent, {chunkSize: byteCount(manifestContent.length)})
            return {
                sha1,
                manifestSha1: manifestKey.sha1
            }
        }
        else {
            this.#mockFiles.set(sha1, content)
            return {
                sha1
            }
        }
    }
    _createFileManifest(content: Buffer, chunkSize: ByteCount) {
        var shasum = crypto.createHash('sha1')
        shasum.update(content)
        const sha1 = shasum.digest('hex') as any as Sha1Hash
        const chunks: FileManifestChunk[] = []
        let i = 0
        while (i < content.length) {
            const i2 = Math.min(content.length, i + byteCountToNumber(chunkSize))
            const chunkContent = content.slice(i, i2)
            const chunkSha1Sum = crypto.createHash('sha1')
            chunkSha1Sum.update(chunkContent)
            const chunkSha1 = chunkSha1Sum.digest('hex') as any as Sha1Hash
            this.storeFile(chunkSha1, chunkContent)
            chunks.push({
                start: byteCount(i),
                end: byteCount(i2),
                sha1: chunkSha1
            })
            i += byteCountToNumber(chunkSize)
        }
        return {
            sha1,
            size: byteCount(content.length),
            chunks
        }
    }
}