import type {
  MetadataBearer,
  ResponseMetadata,
  Command,
  Client,
} from '@aws-sdk/types';

import type { RegionInputConfig } from '@aws-sdk/config-resolver';

import { isThrottlingError } from '@aws-sdk/service-error-classification';

import ServiceSegment from '../segments/attributes/aws';

import { stringify } from 'querystring';

import {
  Subsegment,
  Segment,
  getNamespace,
  resolveSegment,
  setSegment,
} from '..';


var contextUtils = require('../context_utils');

var logger = require('../logger');

import { getCauseTypeFromHttpStatus } from '../utils';

type HttpResponse = { response: { status: number } };

async function buildAttributesFromMetadata(
  client: any,
  command: any,
  metadata: ResponseMetadata,
): Promise<[ServiceSegment, HttpResponse]> {
  const { httpHeaders, httpStatusCode: statusCode, retries } = metadata;
  const serviceIdentifier = client.config.signingName as string;

  let operation: string = command.constructor.name.slice(0, -7);
  operation = operation.charAt(0).toLowerCase() + operation.slice(1);

  const aws = new ServiceSegment(
    {
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
    },
    serviceIdentifier,
  );

  const http = { response: { status: statusCode || 0 } };
  return [aws, http];
}

function addFlags(http: HttpResponse, subsegment: Subsegment, err?: Error): void {
  if (err && isThrottlingError(err)) {
    subsegment.addThrottleFlag();
  } else if (http.response?.status === 429) {
    subsegment.addThrottleFlag();
  }

  const cause = getCauseTypeFromHttpStatus(http.response.status);
  if (cause === 'fault') {
    subsegment.addFaultFlag();
  } else if (cause === 'error') {
    subsegment.addErrorFlag();
  }
}

type DefaultConfiguration = RegionInputConfig & {
  signingName: string;
};

export function captureAWSClient<
  Input extends object,
  Output extends MetadataBearer,
  Configuration extends DefaultConfiguration
>(client: Client<Input, Output, Configuration>): Client<Input, Output, Configuration> {
  // create local copy so that we can later call it
  const send = client.send;

  const serviceIdentifier = client.config.signingName;

  client.send = async (command: any): Promise<Output> => {
    const segment = contextUtils.resolveSegment();

    let operation: string = command.constructor.name.slice(0, -7);
    operation = operation.charAt(0).toLowerCase() + operation.slice(1);

    if (!segment) {
      var output = serviceIdentifier + '.' + operation;

      if (!contextUtils.isAutomaticMode()) {
        logger.getLogger().info('Call ' + output + ' requires a segment object' +
          ' on the request params as "XRaySegment" for tracing in manual mode. Ignoring.');
      } else {
        logger.getLogger().info('Call ' + output +
          ' is missing the sub/segment context for automatic mode. Ignoring.');
      }
      return send.apply(client, [command]) as Promise<Output>;
    }

    const subsegment = segment.addNewSubsegment(serviceIdentifier);
    subsegment.addAttribute('namespace', 'aws');

    const stack = new Error().stack;

    try {
      const res = (await send.apply(client, [command])) as Output;

      if (!res) throw new Error('Unexpected response.');

      const [aws, http] = await buildAttributesFromMetadata(
        client,
        command,
        res.$metadata,
      );

      subsegment.addAttribute('aws', aws);
      subsegment.addAttribute('http', http);

      addFlags(http, subsegment);
      subsegment.close();
      return res;
    } catch (err) {
      const [aws, http] = await buildAttributesFromMetadata(
        client,
        command,
        err.$metadata,
      );

      subsegment.addAttribute('aws', aws);
      subsegment.addAttribute('http', http);

      const errObj = { message: err.message, name: err.name, stack };

      addFlags(http, subsegment, err);

      subsegment.close(errObj, true);
      throw err;
    }
  };

  client.middlewareStack.add(
    (next) => async (args: any) => {
      const segment = contextUtils.resolveSegment();
      if (!segment) return next(args);

      const parent = (segment instanceof Subsegment
        ? segment.segment
        : segment);

      args.request.headers['X-Amzn-Trace-Id'] = stringify(
        {
          Root: parent.trace_id,
          Parent: segment.id,
          Sampled: parent.notTraced ? '0' : '1',
        },
        ';',
      );
      return next(args);
    },
    {
      step: 'build',
    },
  );

  return client;
}
