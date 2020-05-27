import type { MetadataBearer, Client } from '@aws-sdk/types';
import type { RegionInputConfig } from '@aws-sdk/config-resolver';
declare type DefaultConfiguration = RegionInputConfig & {
    signingName: string;
};
export declare function captureAWSClient<Input extends object, Output extends MetadataBearer, Configuration extends DefaultConfiguration>(client: Client<Input, Output, Configuration>): Client<Input, Output, Configuration>;
export {};
