import { HttpRequestOptions, HttpResponse, Headers } from "@nativescript/core/http";
import { addHeader } from "@nativescript/core/http/http-request";
import { ImageSource } from "@nativescript/core/image-source/image-source";
import {
    HTTPFormData,
    HTTPFormDataEntry,
    getFilenameFromUrl,
} from "./http.common";
export {HTTPFormData, HTTPFormDataEntry } from "./http.common";
import * as types from "@nativescript/core/utils/types";
import * as domainDebugger from "tns-core-modules/debugger";
import * as fs from "tns-core-modules/file-system";

export enum HttpResponseEncoding {
    UTF8,
    GBK
}

const currentDevice = UIDevice.currentDevice;
const device = currentDevice.userInterfaceIdiom === UIUserInterfaceIdiom.Phone ? "Phone" : "Pad";
const osVersion = currentDevice.systemVersion;

const GET = "GET";
const USER_AGENT_HEADER = "User-Agent";
const USER_AGENT = `Mozilla/5.0 (i${device}; CPU OS ${osVersion.replace(".", "_")} like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/${osVersion} Mobile/10A5355d Safari/8536.25`;
const sessionConfig = NSURLSessionConfiguration.defaultSessionConfiguration;
const queue = NSOperationQueue.mainQueue;

function parseJSON(source: string): any {
    const src = source.trim();
    if (src.lastIndexOf(")") === src.length - 1) {
        return JSON.parse(src.substring(src.indexOf("(") + 1, src.lastIndexOf(")")));
    }

    return JSON.parse(src);
}

class NSURLSessionTaskDelegateImpl extends NSObject implements NSURLSessionTaskDelegate {
    public static ObjCProtocols = [NSURLSessionTaskDelegate];
    public URLSessionTaskWillPerformHTTPRedirectionNewRequestCompletionHandler(session: NSURLSession, task: NSURLSessionTask, response: NSHTTPURLResponse, request: NSURLRequest, completionHandler: (p1: NSURLRequest) => void): void {
        completionHandler(null);
    }
}
const sessionTaskDelegateInstance: NSURLSessionTaskDelegateImpl = <NSURLSessionTaskDelegateImpl>NSURLSessionTaskDelegateImpl.new();

let defaultSession;
function ensureDefaultSession() {
    if (!defaultSession) {
        defaultSession = NSURLSession.sessionWithConfigurationDelegateDelegateQueue(sessionConfig, null, queue);
    }
}

let sessionNotFollowingRedirects;
function ensureSessionNotFollowingRedirects() {
    if (!sessionNotFollowingRedirects) {
        sessionNotFollowingRedirects = NSURLSession.sessionWithConfigurationDelegateDelegateQueue(sessionConfig, sessionTaskDelegateInstance, queue);
    }
}

export function request(options: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {

        if (!options.url) {
            reject(new Error("Request url was empty."));

            return;
        }

        try {
            const network = domainDebugger.getNetwork();
            const debugRequest = network && network.create();

            const urlRequest = NSMutableURLRequest.requestWithURL(
                NSURL.URLWithString(options.url));

            urlRequest.HTTPMethod = types.isDefined(options.method) ? options.method : GET;

            urlRequest.setValueForHTTPHeaderField(USER_AGENT, USER_AGENT_HEADER);

            if (options.headers) {
                for (let header in options.headers) {
                    urlRequest.setValueForHTTPHeaderField(options.headers[header] + "", header);
                }
            }

            if (types.isString(options.content) || options.content instanceof FormData) {
                urlRequest.HTTPBody = NSString.stringWithString(options.content.toString()).dataUsingEncoding(4);
            } else if (options.content instanceof ArrayBuffer) {
                const buffer = options.content as ArrayBuffer;
                urlRequest.HTTPBody = NSData.dataWithData(buffer as any);
            }

            if (types.isNumber(options.timeout)) {
                urlRequest.timeoutInterval = options.timeout / 1000;
            }

            let session;
            if (types.isBoolean(options.dontFollowRedirects) && options.dontFollowRedirects) {
                ensureSessionNotFollowingRedirects();
                session = sessionNotFollowingRedirects;
            } else {
                ensureDefaultSession();
                session = defaultSession;
            }

            const dataTask = session.dataTaskWithRequestCompletionHandler(urlRequest,
                function (data: NSData, response: NSHTTPURLResponse, error: NSError) {
                    if (error) {
                        reject(new Error(error.localizedDescription));
                    } else {
                        const headers: Headers = {};
                        if (response && response.allHeaderFields) {
                            const headerFields = response.allHeaderFields;

                            headerFields.enumerateKeysAndObjectsUsingBlock((key, value, stop) => {
                                addHeader(headers, key, value);
                            });
                        }

                        if (debugRequest) {
                            debugRequest.mimeType = response.MIMEType;
                            debugRequest.data = data;
                            const debugResponse = {
                                url: options.url,
                                status: response.statusCode,
                                statusText: NSHTTPURLResponse.localizedStringForStatusCode(response.statusCode),
                                headers: headers,
                                mimeType: response.MIMEType,
                                fromDiskCache: false
                            };
                            debugRequest.responseReceived(debugResponse);
                            debugRequest.loadingFinished();
                        }

                        resolve({
                            content: {
                                raw: data,
                                toArrayBuffer: () => interop.bufferFromData(data),
                                toString: (encoding?: any) => {
                                    const str = NSDataToString(data, encoding);
                                    if (typeof str === "string") {
                                        return str;
                                    } else {
                                        throw new Error("Response content may not be converted to string");
                                    }
                                },
                                toJSON: (encoding?: any) => parseJSON(NSDataToString(data, encoding)),
                                toImage: () => {
                                    return new Promise((resolve, reject) => {
                                        (<any>UIImage).tns_decodeImageWithDataCompletion(data, image => {
                                            if (image) {
                                                resolve(new ImageSource(image));
                                            } else {
                                                reject(new Error("Response content may not be converted to an Image"));
                                            }
                                        });
                                    });
                                },
                                toFile: (destinationFilePath?: string) => {
                                    if (!destinationFilePath) {
                                        destinationFilePath = getFilenameFromUrl(options.url);
                                    }
                                    if (data instanceof NSData) {
                                        // ensure destination path exists by creating any missing parent directories
                                        const file = fs.File.fromPath(destinationFilePath);

                                        data.writeToFileAtomically(destinationFilePath, true);

                                        return file;
                                    } else {
                                        reject(new Error(`Cannot save file with path: ${destinationFilePath}.`));
                                    }

                                    return null;
                                }
                            },
                            statusCode: response.statusCode,
                            headers: headers
                        });
                    }
                });

            if (options.url && debugRequest) {
                const request = {
                    url: options.url,
                    method: "GET",
                    headers: options.headers
                };
                debugRequest.requestWillBeSent(request);
            }

            dataTask.resume();
        } catch (ex) {
            reject(ex);
        }
    });
}

function NSDataToString(data: any, encoding?: HttpResponseEncoding): string {
    let code = NSUTF8StringEncoding; // long:4

    if (encoding === HttpResponseEncoding.GBK) {
        code = CFStringEncodings.kCFStringEncodingGB_18030_2000; // long:1586
    }

    let encodedString = NSString.alloc().initWithDataEncoding(data, code);

    // If UTF8 string encoding fails try with ISO-8859-1
    if (!encodedString) {
        code = NSISOLatin1StringEncoding; // long:5
        encodedString = NSString.alloc().initWithDataEncoding(data, code);
    }

    return encodedString.toString();
}

export function getString(arg: any): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        request(typeof arg === "string" ? { url: arg, method: "GET" } : arg)
            .then(r => {
                try {
                    const str = r.content.toString();
                    resolve(str);
                } catch (e) {
                    reject(e);
                }
            }, e => reject(e));
    });
}

export function getJSON<T>(arg: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request(typeof arg === "string" ? { url: arg, method: "GET" } : arg)
            .then(r => {
                try {
                    const json = r.content.toJSON();
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            }, e => reject(e));
    });
}

export function getImage(arg: any): Promise<ImageSource> {
    return new Promise<any>((resolve, reject) => {
        request(typeof arg === "string" ? { url: arg, method: "GET" } : arg)
            .then(r => {
                try {
                    resolve(r.content.toImage());
                } catch (err) {
                    reject(err);
                }
            }, err => {
                reject(err);
            });
    });
}

export function getFile(arg: any, destinationFilePath?: string): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        request(typeof arg === "string" ? { url: arg, method: "GET" } : arg)
            .then(r => {
                try {
                    const file = r.content.toFile(destinationFilePath);
                    resolve(file);
                } catch (e) {
                    reject(e);
                }
            }, e => reject(e));
    });
}

export function getBinary(arg: any): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
        request(typeof arg === "string" ? { url: arg, method: "GET" } : arg)
            .then(r => {
                try {
                    const arrayBuffer = r.content.toArrayBuffer();
                    resolve(arrayBuffer);
                } catch (e) {
                    reject(e);
                }
            }, e => reject(e));
    });
}
