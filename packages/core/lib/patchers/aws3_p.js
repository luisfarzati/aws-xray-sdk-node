"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureAWSClient = void 0;
const service_error_classification_1 = require("@aws-sdk/service-error-classification");
const aws_1 = __importDefault(require("../segments/attributes/aws"));
const querystring_1 = require("querystring");
const __1 = require("..");
var contextUtils = require('../context_utils');
var logger = require('../logger');
const utils_1 = require("../utils");
async function buildAttributesFromMetadata(client, command, metadata) {
    const { httpHeaders, httpStatusCode: statusCode, retries } = metadata;
    const serviceIdentifier = client.config.signingName;
    let operation = command.constructor.name.slice(0, -7);
    operation = operation.charAt(0).toLowerCase() + operation.slice(1);
    const aws = new aws_1.default({
        extendedRequestId: httpHeaders && httpHeaders['x-amz-id-2'],
        requestId: httpHeaders && httpHeaders['x-amz-request-id'],
        retryCount: retries,
        request: {
            operation,
            httpRequest: {
                region: await client.config.region(),
                statusCode,
            },
            params: command.input,
        },
    }, serviceIdentifier);
    const http = { response: { status: statusCode || 0 } };
    return [aws, http];
}
function addFlags(http, subsegment, err) {
    var _a;
    if (err && service_error_classification_1.isThrottlingError(err)) {
        subsegment.addThrottleFlag();
    }
    else if (((_a = http.response) === null || _a === void 0 ? void 0 : _a.status) === 429) {
        subsegment.addThrottleFlag();
    }
    const cause = utils_1.getCauseTypeFromHttpStatus(http.response.status);
    if (cause === 'fault') {
        subsegment.addFaultFlag();
    }
    else if (cause === 'error') {
        subsegment.addErrorFlag();
    }
}
function captureAWSClient(client) {
    // create local copy so that we can later call it
    const send = client.send;
    const serviceIdentifier = client.config.signingName;
    client.send = async (command) => {
        const segment = contextUtils.resolveSegment();
        let operation = command.constructor.name.slice(0, -7);
        operation = operation.charAt(0).toLowerCase() + operation.slice(1);
        if (!segment) {
            var output = serviceIdentifier + '.' + operation;
            if (!contextUtils.isAutomaticMode()) {
                logger.getLogger().info('Call ' + output + ' requires a segment object' +
                    ' on the request params as "XRaySegment" for tracing in manual mode. Ignoring.');
            }
            else {
                logger.getLogger().info('Call ' + output +
                    ' is missing the sub/segment context for automatic mode. Ignoring.');
            }
            return send.apply(client, [command]);
        }
        const subsegment = segment.addNewSubsegment(serviceIdentifier);
        subsegment.addAttribute('namespace', 'aws');
        const stack = new Error().stack;
        try {
            const res = (await send.apply(client, [command]));
            if (!res)
                throw new Error('Unexpected response.');
            const [aws, http] = await buildAttributesFromMetadata(client, command, res.$metadata);
            subsegment.addAttribute('aws', aws);
            subsegment.addAttribute('http', http);
            addFlags(http, subsegment);
            subsegment.close();
            return res;
        }
        catch (err) {
            const [aws, http] = await buildAttributesFromMetadata(client, command, err.$metadata);
            subsegment.addAttribute('aws', aws);
            subsegment.addAttribute('http', http);
            const errObj = { message: err.message, name: err.name, stack };
            addFlags(http, subsegment, err);
            subsegment.close(errObj, true);
            throw err;
        }
    };
    client.middlewareStack.add((next) => async (args) => {
        const segment = contextUtils.resolveSegment();
        if (!segment)
            return next(args);
        const parent = (segment instanceof __1.Subsegment
            ? segment.segment
            : segment);
        args.request.headers['X-Amzn-Trace-Id'] = querystring_1.stringify({
            Root: parent.trace_id,
            Parent: segment.id,
            Sampled: parent.notTraced ? '0' : '1',
        }, ';');
        return next(args);
    }, {
        step: 'build',
    });
    return client;
}
exports.captureAWSClient = captureAWSClient;
