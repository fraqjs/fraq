import {
  type AnyApiCall,
  type MilkyEventSource,
  type MilkyEventSubscription,
  type milky,
  serviceToken,
} from '@fraqjs/fraq';

import {
  type MockFriendMessageOptions,
  type MockGroupMessageOptions,
  MockInbox,
  type MockInboxOptions,
  type MockTempMessageOptions,
} from './inbox';

export interface MockApiCall {
  endpoint: string;
  params?: unknown;
}

export interface MockServiceOptions extends MockInboxOptions {
  inbox?: MockInbox;
}

export class MockService implements MilkyEventSource {
  static readonly token = serviceToken<MockService>('fraqjs/mock/MockService');

  readonly name = 'mock';
  readonly inbox: MockInbox;

  readonly apiCalls: MockApiCall[] = [];

  private onEvent: ((event: milky.Event) => void | Promise<void>) | undefined;
  private closeEventsResolver: (() => void) | undefined;
  startEventCalls = 0;
  private nextStartError: unknown;

  constructor(options: MockServiceOptions = {}) {
    this.inbox = options.inbox ?? new MockInbox(options);
  }

  async start(handler: (event: milky.Event) => void | Promise<void>): Promise<MilkyEventSubscription> {
    this.startEventCalls += 1;
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = undefined;
      throw error;
    }

    this.onEvent = handler;
    const closed = new Promise<void>((resolve) => {
      this.closeEventsResolver = resolve;
    });

    return {
      closed,
      stop: () => {
        this.closeEvents();
      },
    };
  }

  closeEvents(): void {
    this.closeEventsResolver?.();
    this.closeEventsResolver = undefined;
    this.onEvent = undefined;
  }

  failNextStart(error: unknown): void {
    this.nextStartError = error;
  }

  async emitEvent(event: milky.Event): Promise<void> {
    await this.onEvent?.(event);
  }

  async receiveFriend(
    options: MockFriendMessageOptions,
    segments: readonly milky.IncomingSegment_ZodInput[] | readonly milky.IncomingSegment[],
  ): Promise<milky.IncomingFriendMessage> {
    const event = this.inbox.friendEvent(options, segments);
    await this.emitEvent(event);
    return event.data as milky.IncomingFriendMessage;
  }

  async receiveGroup(
    options: MockGroupMessageOptions,
    segments: readonly milky.IncomingSegment_ZodInput[] | readonly milky.IncomingSegment[],
  ): Promise<milky.IncomingGroupMessage> {
    const event = this.inbox.groupEvent(options, segments);
    await this.emitEvent(event);
    return event.data as milky.IncomingGroupMessage;
  }

  async receiveTemp(
    options: MockTempMessageOptions,
    segments: readonly milky.IncomingSegment_ZodInput[] | readonly milky.IncomingSegment[],
  ): Promise<milky.IncomingTempMessage> {
    const event = this.inbox.tempEvent(options, segments);
    await this.emitEvent(event);
    return event.data as milky.IncomingTempMessage;
  }

  // Terminal API hook: records the call, then answers the read-side endpoints
  // from the inbox. Everything else resolves to {} — enough for send_* callers
  // that destructure message_seq. Register your own ctx.hookApi before this to
  // stub specific responses.
  handleApiCall(call: AnyApiCall): unknown {
    this.apiCalls.push({ endpoint: call.endpoint, params: call.params });
    const params = call.params as never;
    switch (call.endpoint) {
      case 'get_message':
        return this.inbox.getMessage(params);
      case 'get_history_messages':
        return this.inbox.getHistoryMessages(params);
      case 'mark_message_as_read':
        return this.inbox.markMessageAsRead(params);
      case 'get_friend_info':
        return this.inbox.getFriendInfo(params);
      case 'get_group_info':
        return this.inbox.getGroupInfo(params);
      case 'get_group_member_info':
        return this.inbox.getGroupMemberInfo(params);
      default:
        return {};
    }
  }

  reset(): void {
    this.apiCalls.length = 0;
    this.inbox.reset();
  }
}
