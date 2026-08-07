import type {
  ScopedServiceFactory as KernelScopedServiceFactory,
  ServiceScope as KernelServiceScope,
} from '@fraqjs/kernel';

import type { Context } from './context';

export type {
  Disposable,
  ServiceClass,
  ServiceIdentifier,
  ServiceToken,
} from '@fraqjs/kernel';
export {
  implementsESNextDisposable,
  isDisposable,
  serviceToken,
} from '@fraqjs/kernel';

export type ServiceScope = KernelServiceScope<Context>;
export type ScopedServiceFactory<T extends object> = KernelScopedServiceFactory<T, Context>;
