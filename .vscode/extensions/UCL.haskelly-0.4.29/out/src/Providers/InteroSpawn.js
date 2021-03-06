"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const InitIntero_1 = require("./InitIntero");
const workDir_1 = require("../utils/workDir");
const document_1 = require("../utils/document");
const promise_1 = require("../utils/promise");
const StreamSplitter = require('stream-splitter');
class InteroSpawn {
    constructor() {
        if (InteroSpawn._instance) {
            throw new Error("Error: Instantiation failed: Use SingletonClass.getInstance() instead of new.");
        }
        InteroSpawn._instance = this;
        this.listenChanges();
    }
    static getInstance() {
        return InteroSpawn._instance;
    }
    /**
     * Initialize Spawn process with Stack and Intero
     */
    tryNewIntero(documentPath) {
        return new Promise((resolve, reject) => {
            // Load GHCi in temp shell
            const filePath = document_1.normalizePath(documentPath);
            const workDir = workDir_1.getWorkDir(filePath);
            const isStack = workDir["cwd"] !== undefined;
            console.log(`Trying new Intero for document ${filePath} and workDir ${workDir["cwd"]}`);
            this.loadIntero(isStack, workDir, filePath)
                .then(result => {
                console.log('Intero loaded correctly');
                resolve();
            })
                .catch(error => {
                console.log('Intero failed to load');
                reject(error);
            })
                .then(() => {
                this.loading = false;
            });
        });
    }
    loadIntero(isStack, workDir, documentPath) {
        return new Promise((resolve, reject) => {
            let stackLoaded;
            if (!this.loading) {
                this.loading = true;
                const intero = new InitIntero_1.default(['stack', 'ghci', '--with-ghc', 'intero'], workDir, isStack, (failed) => {
                    if (!stackLoaded) {
                        if (failed) {
                            intero.killProcess();
                            reject();
                        }
                        else if (isStack) {
                            stackLoaded = true;
                            this.killCurrentShell();
                            this.openedDocument = workDir["cwd"];
                            this.shell = intero.getShell();
                            this.shellOutput();
                            resolve();
                        }
                        else {
                            stackLoaded = true;
                            let fileLoaded = false;
                            intero.runCommand(`:l "${this.normaliseFilePath(documentPath)}"`, (error) => {
                                if (!fileLoaded) {
                                    fileLoaded = true;
                                    if (error) {
                                        intero.killProcess();
                                        reject();
                                        return;
                                    }
                                    else {
                                        this.killCurrentShell();
                                        this.openedDocument = documentPath;
                                        this.shell = intero.getShell();
                                        this.shellOutput();
                                        resolve();
                                        return;
                                    }
                                }
                            });
                        }
                    }
                });
            }
        });
    }
    listenChanges() {
        const reload = (document) => {
            this.tryNewIntero(document.uri.fsPath)
                .catch(e => console.error(e));
        };
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId == 'haskell') {
                reload(document);
            }
        });
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'haskell') {
                const stackDir = workDir_1.getWorkDir(editor.document.uri.fsPath)["cwd"];
                // Avoid reload if opened document from same Stack project
                if (stackDir && (this.openedDocument !== stackDir)) {
                    this.openedDocument = stackDir;
                    reload(editor.document);
                }
                else if (!stackDir && (this.openedDocument !== editor.document.uri.fsPath)) {
                    this.openedDocument = editor.document.uri.fsPath;
                    reload(editor.document);
                }
            }
        });
    }
    killCurrentShell() {
        if (this.shell) {
            this.shell.stdin.pause();
            this.shell.kill();
        }
        return Promise.resolve();
    }
    /**
     * Intero requests
     */
    requestCompletions(filePath, position, word) {
        return new Promise((resolve, reject) => {
            if (this.shell && !this.loading) {
                this.requestingCompletion = true;
                this.shell.stdin.write(`:complete-at "${this.normaliseFilePath(filePath)}" ${position.line} ${position.character} ${position.line} ${position.character} "${word}"\n`);
                if (this.interoOutput) {
                    setTimeout(() => {
                        const suggestions = this.interoOutput.split('\n');
                        const completionItems = [];
                        suggestions.forEach(suggestion => {
                            if (suggestion) {
                                completionItems.push(new vscode.CompletionItem(suggestion.trim().replace(/\s+/g, ' ')));
                            }
                        });
                        resolve(completionItems);
                    }, 35);
                }
                else {
                    resolve([]);
                }
            }
        });
    }
    requestType(filePath, position, wordInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            const word = wordInfo['word'];
            const start = wordInfo['start'];
            const end = wordInfo['end'];
            const getTypeDefCommand = `:type-at "${this.normaliseFilePath(filePath)}" ${position.line + 1} ${start + 1} ${position.line + 1} ${end + 1} "${word}"`;
            try {
                const output = yield this.executeCommandOnIntero(getTypeDefCommand);
                return new vscode.Hover({ language: 'haskell', value: output });
            }
            catch (e) {
                return new vscode.Hover('Type not available.');
            }
        });
    }
    requestDefinition(filePath, position, wordInfo) {
        const word = wordInfo['word'];
        const start = wordInfo['start'];
        const end = wordInfo['end'];
        const locateDefinitionCommand = `:loc-at "${this.normaliseFilePath(filePath)}" ${position.line + 1} ${start + 1} ${position.line + 1} ${end + 1} "${word}"`;
        return this.executeCommandOnIntero(locateDefinitionCommand);
    }
    normaliseFilePath(filePath) {
        return filePath.replace(/\\/g, "\\\\");
    }
    executeCommandOnIntero(command) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.shell || this.loading)
                return '';
            this.interoOutput = undefined;
            this.shell.stdin.write(`${command}\n`);
            yield promise_1.delay(50);
            if (this.interoOutput !== ' ' && this.interoOutput !== undefined) {
                return this.interoOutput.trim().replace(/\s+/g, ' ');
            }
            else {
                throw new Error('Command output not available');
            }
        });
    }
    /**
     *  Intero output parser
     */
    shellOutput() {
        const splitter = this.shell.stdout.pipe(StreamSplitter("lambda>"));
        splitter.encoding = 'utf8';
        splitter.on('token', (token) => {
            this.interoOutput = token;
        });
        splitter.on('done', () => {
            console.log("Intero spawn terminated.");
        });
        splitter.on('error', (e) => {
            console.log("error: ", e);
        });
    }
}
InteroSpawn._instance = new InteroSpawn();
exports.default = InteroSpawn;
//# sourceMappingURL=InteroSpawn.js.map