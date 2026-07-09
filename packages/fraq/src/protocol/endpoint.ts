import type * as types from './types';

export type ApiEndpointName = keyof types.ApiEndpoints;

type RequiredKeys<T> = {
  // biome-ignore lint/complexity/noBannedTypes: used for checking if a type is optional
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type AllOptional<T> = RequiredKeys<T> extends never ? true : false;

type RawApiEndpoint<E extends ApiEndpointName> = {
  request: types.ApiEndpoints[E]['request_ZodInput'] extends null ? null : types.ApiEndpoints[E]['request_ZodInput'];
  response: types.ApiEndpoints[E]['response'] extends null ? null : types.ApiEndpoints[E]['response'];
};

export type ApiRequest<E extends ApiEndpointName> = RawApiEndpoint<E>['request'];
export type ApiParams<E extends ApiEndpointName> = RawApiEndpoint<E>['request'] extends null
  ? undefined
  : AllOptional<RawApiEndpoint<E>['request']> extends true
    ? RawApiEndpoint<E>['request'] | undefined
    : RawApiEndpoint<E>['request'];
export type ApiResponse<E extends ApiEndpointName> = RawApiEndpoint<E>['response'];

export interface ApiCall<E extends ApiEndpointName = ApiEndpointName> {
  endpoint: E;
  params: ApiParams<E>;
}

export type ApiNext<E extends ApiEndpointName> =
  undefined extends ApiParams<E>
    ? (params?: ApiParams<E>) => Promise<ApiResponse<E>>
    : (params: ApiParams<E>) => Promise<ApiResponse<E>>;

export type ApiHook<E extends ApiEndpointName> = (
  params: ApiParams<E>,
  next: ApiNext<E>,
  call: ApiCall<E>,
) => ApiResponse<E> | Promise<ApiResponse<E>>;

export type AnyApiCall = {
  [E in ApiEndpointName]: ApiCall<E>;
}[ApiEndpointName];

export type AnyApiNext = (params?: unknown) => Promise<unknown>;

export type AnyApiHook = (call: AnyApiCall, next: AnyApiNext) => unknown | Promise<unknown>;

type ApiEndpointFunction<E extends ApiEndpointName> = RawApiEndpoint<E>['request'] extends null
  ? () => Promise<ApiResponse<E>>
  : AllOptional<RawApiEndpoint<E>['request']> extends true
    ? (params?: RawApiEndpoint<E>['request']) => Promise<ApiResponse<E>>
    : (params: RawApiEndpoint<E>['request']) => Promise<ApiResponse<E>>;

export type ApiEndpoints = {
  [E in ApiEndpointName]: ApiEndpointFunction<E>;
};

export type EventMap = { [K in types.Event['event_type']]: Extract<types.Event, { event_type: K }> };
