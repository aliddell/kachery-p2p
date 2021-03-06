import fs from 'fs';
import assert from 'assert';
import { sleepMsec, sha1MatchesFileKey } from "../common/util.js";
import { validateObject, validateSha1Hash } from "../schema/index.js";
import { sha1sum } from "../common/crypto_util.js";
import { createTemporaryFilePath, moveFileIntoKacheryStorage } from "../kachery.js";

class FileLoader {
    constructor({fileKey}) {
        validateObject(fileKey, '/FileKey');

        this._fileKey = fileKey;
        this._numBytes = null;
        this._testByteRange = null;
        this._fileProvidersPlus = [];

        this._onFinishedCallbacks = [];
        this._onErrorCallbacks = [];
        this._onProgressCallbacks = [];

        this._onNewProviderCallbacks = [];

        this._finishedFindingProvidersReported = false;

        this._halt = false;

        this._start();
    }
    cancel() {
        this._halt = true;
    }
    onFinished(cb) {
        this._onFinishedCallbacks.push(cb);
    }
    onError(cb) {
        this._onErrorCallbacks.push(cb);
    }
    onProgress(cb) {
        this._onProgressCallbacks.push(cb);
    }
    addFileProvider(provider) {
        if (this._numBytes === null) {
            this._numBytes = provider.fileSize();
            let testNumBytes = Math.floor(Math.min(100 * 1000, this._numBytes / 5)); // no more than 1/5 of total file. No more than 100K
            testNumBytes = Math.max(10000, testNumBytes); // no less than 10000
            testNumBytes = Math.min(testNumBytes, this._numBytes); // no more than total size
            this._testByteRange = [0, testNumBytes]; // todo: use a random offset in the range
        }
        for (let pPrev of this._fileProvidersPlus) {
            if (provider.fileSize() !== pPrev.info.fileSize) {
                console.warn(`We have inconsistent file sizes reported from peers: ${provider.nodeId().slice(0, 6)} ${pPrev.provider.nodeId().slice(0, 6)}`);
            }
        }
        const pp = {
            info: {
                fileSize: provider.fileSize()
            },
            provider
        };
        this._fileProvidersPlus.push(pp);
        
        this._onNewProviderCallbacks.forEach(cb => cb(pp));
    }
    reportFinishedFindingProviders() {
        this._finishedFindingProvidersReported = true;
    }
    _onNewProvider(cb) {
        this._fileProvidersPlus.forEach(p => {
            cb(p);
        });
        this._onNewProviderCallbacks.push(cb);
    }
    async _start() {
        let complete = false;
        this._providersThatPassedTestLoad = [];

        const _startTestDownload = (p) => {
            assert(this._testByteRange !== null, 'Unexpected: testByteRange is null.');
            const {onError, onFinished, onProgress, cancel} = p.provider.loadData({
                startByte: this._testByteRange[0],
                endByte: this._testByteRange[1],
                timeout: 5000
            });
            onError((err) => {
                p.info.testError = err;
            });
            onFinished(({data: testData, sha1: testSha1}) => {
                p.info.testFinished = true;
                p.info.testData = testData;
                p.info.testSha1 = testSha1;
                for (let pPrev of this._providersThatPassedTestLoad) {
                    if (pPrev.info.testSha1 !== p.info.testSha1) {
                        console.warn(`We have inconsist file data from peers: ${p.provider.nodeId().slice(0, 6)} ${pPrev.provider.nodeId().slice(0, 6)}`);
                    }
                }
                this._providersThatPassedTestLoad.push(p);
            });
            onProgress((progress) => {
                p.info.testProgress= progress;
            });
            p.info.testCancel = () => cancel();
        }

        const _startFullDownload = (p) => {
            const {onError, onFinished, onProgress, cancel} = p.provider.loadData({
                startByte: 0,
                endByte: this._numBytes,
                appendToFilePath: p.info.temporaryFilePath,
                timeout: 10000
            });
            onError((err) => {
                console.warn(`Error in download: ${err.message}`);
                p.info.fullError = err;
            });
            onFinished(({data: dataShouldByNull, sha1}) => {
                if (!sha1MatchesFileKey({sha1, fileKey: this._fileKey})) {
                    p.info.fullError = 'Unexpected SHA-1';
                    p.info.fullFinished = true;
                    return;
                }
                p.info.fullSha1 = sha1;
                p.info.fullFinished = true;
            });
            onProgress((progress) => {
                p.info.fullProgress = progress;
                this._onProgressCallbacks.forEach(cb => cb(progress));
            });
            p.info.fullCancel = () => cancel();
        }
        
        this._onNewProvider(p => {
            if (complete) return;
            _startTestDownload(p);
        });

        let pIndex = 0;
        let passNumber = 1; // do two passes
        let timer = 0;
        while (true) {
            if (complete) return;
            if (this._halt) {
                complete = true;
                for (let p0 of this._fileProvidersPlus) {
                    if (p0.info.testCancel) p0.info.testCancel();
                    if (p0.info.fullCancel) p0.info.fullCancel();
                    if (p0.info.temporaryFilePath) {
                        if (fs.existsSync(p0.info.temporaryFilePath)) {
                            fs.unlinkSync(p0.info.temporaryFilePath);
                        }
                    }
                }
                return;
            }
            if (pIndex < this._providersThatPassedTestLoad.length) {
                const pp = this._providersThatPassedTestLoad[pIndex];
                if (!pp.info.fullStarted) {
                    pp.info.fullStarted = true;
                    pp.info.temporaryFilePath = createTemporaryFilePath({prefix: 'kachery-p2p-'});
                    _startFullDownload(pp);
                }
                else if (pp.info.fullFinished) {
                    complete = true;
                    const stat0 = fs.statSync(pp.info.temporaryFilePath);
                    if (stat0.size !== this._numBytes) {
                        const err2 = new Error(`Unexpected. Size of downloaded file is ${stat0.size}. Expected ${this._numBytes}.`);
                        console.warn(err2.message);
                        this._onErrorCallbacks.forEach(cb => cb(err2));
                        return;
                    }
                    let path = null;
                    try {
                        path = moveFileIntoKacheryStorage({path: pp.info.temporaryFilePath, sha1: pp.info.fullSha1});
                    }
                    catch(err) {
                        const err2 = new Error(`Unexpected. Unable to move file into kachery storage: ${err.message}`);
                        console.warn(err2.message);                        
                        this._onErrorCallbacks.forEach(cb => cb(err2));
                        return;
                    }
                    this._onFinishedCallbacks.forEach(cb => cb({sha1: pp.info.fullSha1, path }));
                }
                else if (pp.info.fullError) {
                    console.warn(`Error downloading file: ${pp.info.fullError}`);
                    if (fs.existsSync(pp.info.temporaryFilePath)) {
                        fs.unlinkSync(pp.info.temporaryFilePath);
                    }
                    pIndex ++;
                    if (pIndex >= this._providersThatPassedTestLoad.lenth) {
                        if (passNumber < 2) {
                            passNumber ++;
                            pIndex = 0;
                        }
                    }
                    if (pIndex < this._providersThatPassedTestLoad.length) {
                        // we'll give the next one a chance
                        timer = new Date();
                    }
                }
            }
            else {
                if (this._finishedFindingProvidersReported) {
                    if (this._fileProvidersPlus.length === 0) {
                        complete = true;
                        const err = new Error('File not found.');
                        this._onErrorCallbacks.forEach(cb => cb(err));
                        return;
                    }
                    else {
                        const elapsed = (new Date()) - timer;
                        if (elapsed > 15000)  {
                            complete = true;
                            let err;
                            if (this._providersThatPassedTestLoad.length === 0) {
                                err = new Error('File found, but no providers passed test load.')
                            }
                            else {
                                err = new Error('Download failed.')
                            }
                            this._onErrorCallbacks.forEach(cb => cb(err));
                        }
                    }
                }
            }
            await sleepMsec(10);
        }
    }
}

export default FileLoader;