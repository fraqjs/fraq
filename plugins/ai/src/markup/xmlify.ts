import type { Context, milky } from '@fraqjs/fraq';
import render, { type DomSerializerOptions } from 'dom-serializer';
import { Element, Text } from 'domhandler';
import * as hp2 from 'htmlparser2';
import formatXml, { type XMLFormatterOptions } from 'xml-formatter';

import _faces from './faces.json';
import { LightApp } from './light-app';

const faces = _faces as Partial<Record<string, FaceDetail>>;

interface FaceDetail {
  qDes: string;
}

export interface XmlifyOptions {
  maxForwardDepth?: number;
  serialize?: DomSerializerOptions;
  format?: XMLFormatterOptions;
  /**
   * Renders the message as part of a thread: `<message>` only carries `seq`, `sender_id` and `time`,
   * leaving the scene and peer to the enclosing `<thread>`. `xmlifyThread` always sets this.
   *
   * @default false
   */
  inThread?: boolean;
  /**
   * @deprecated Resource keys are now derived from the message seq. Passing this only enables
   * `inThread` and will be removed in the next major version; use `inThread: true` instead.
   */
  resourceIndex?: ResourceIndex;
}

/** @deprecated Resource keys are now derived from the message seq. */
export interface ResourceIndex {
  image: number;
  record: number;
  video: number;
  file: number;
  forward: number;
}

type ResourceType = 'image' | 'record' | 'video' | 'file' | 'forward';

function createResourceCounts(): Record<ResourceType, number> {
  return { image: 0, record: 0, video: 0, file: 0, forward: 0 };
}

/** Numbering space for the resources at one level of a message: the message itself or one forward inside it. */
interface ResourceScope {
  /** Message seq followed by the forward number at each level, e.g. `50.1.2`. */
  path: string;
  /** Depth a forward found in this scope would have. */
  forwardDepth: number;
  counts: Record<ResourceType, number>;
}

export interface XmlifyContext {
  xmlContent: string;
  resources: Record<string, { url: string }>;
  files: Record<string, milky.IncomingFileSegment['data']>;
  forwards: Record<string, milky.IncomingForwardSegment['data']>;
}

function stringifySegments(segments: milky.IncomingSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        return segment.data.text;
      } else {
        return `[${segment.type}]`;
      }
    })
    .join('');
}

function buildPlainNode(name: string, values: object) {
  const element = new Element(name, {});
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'object' && value !== null) {
      hp2.DomUtils.appendChild(element, buildPlainNode(key, value));
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      hp2.DomUtils.appendChild(element, new Element(key, {}, [new Text(String(value))]));
    }
  }
  return element;
}

function buildAttributedElement(name: string, values: object) {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = String(value);
    }
  }
  return new Element(name, attrs);
}

function buildTaggedTextNode(tag: string, text: string, attrs?: object) {
  const element = attrs ? buildAttributedElement(tag, attrs) : new Element(tag, {});
  hp2.DomUtils.appendChild(element, new Text(text));
  return element;
}

/**
 * @deprecated Resource keys are now derived from the message seq. Will be removed in the next major
 * version; pass `inThread: true` instead of a resource index.
 */
export function createResourceIndex(): ResourceIndex {
  return createResourceCounts();
}

export async function xmlifyToElement(ctx: Context, message: milky.IncomingMessage, options?: XmlifyOptions) {
  const maxForwardDepth = options?.maxForwardDepth ?? 0;
  const inThread = options?.inThread ?? options?.resourceIndex !== undefined;

  const root = buildAttributedElement(
    'message',
    inThread
      ? {
          seq: message.message_seq,
          sender_id: message.sender_id,
          time: message.time,
        }
      : {
          scene: message.message_scene,
          peer_id: message.peer_id,
          seq: message.message_seq,
          sender_id: message.sender_id,
          time: message.time,
        },
  );

  const contentNode = new Element('content', {});
  const resources: Record<string, { url: string }> = {};
  const forwards: Record<string, milky.IncomingForwardSegment['data']> = {};
  const files: Record<string, milky.IncomingFileSegment['data']> = {};
  // Keys depend only on the message itself, so the same message renders identically in any window,
  // which keeps the serialized history stable for prompt caching. Each forward opens its own scope
  // (`50` -> `50.1` -> `50.1.2`), so a key never depends on how deeply forwards are expanded:
  // expanding a level only adds keys inside that level and never renumbers its siblings.
  function newResourceKey(scope: ResourceScope, type: ResourceType): string {
    scope.counts[type]++;
    return `${type}-${scope.path}-${scope.counts[type]}`;
  }

  async function buildElementFromSegment(
    segment: milky.IncomingSegment,
    scope: ResourceScope,
  ): Promise<Element | null> {
    switch (segment.type) {
      case 'text': {
        return buildTaggedTextNode('text', segment.data.text);
      }
      case 'mention': {
        return buildTaggedTextNode('mention', segment.data.name, { user_id: segment.data.user_id });
      }
      case 'mention_all': {
        return buildTaggedTextNode('mention', '@全体成员');
      }
      case 'face': {
        const summary = faces[segment.data.face_id]?.qDes?.substring(1) /* to remove `/` prefix */ ?? '';
        return buildTaggedTextNode('face', summary, segment.data);
      }
      case 'reply': {
        const { message_seq, sender_id, time } = segment.data;
        const replyNode = buildTaggedTextNode('reply', stringifySegments(segment.data.segments), {
          message_seq,
          sender_id,
          time,
        });
        return replyNode;
      }
      case 'image': {
        const { resource_id, temp_url, summary, ...rest } = segment.data;
        const resourceKey = newResourceKey(scope, 'image');
        const imageNode = buildTaggedTextNode('image', summary, { id: resourceKey, ...rest });
        resources[resourceKey] = { url: segment.data.temp_url };
        return imageNode;
      }
      case 'record': {
        const { resource_id, temp_url, ...rest } = segment.data;
        const resourceKey = newResourceKey(scope, 'record');
        resources[resourceKey] = { url: segment.data.temp_url };
        return buildAttributedElement('record', { id: resourceKey, ...rest });
      }
      case 'video': {
        const { resource_id, temp_url, ...rest } = segment.data;
        const resourceKey = newResourceKey(scope, 'video');
        resources[resourceKey] = { url: segment.data.temp_url };
        return buildAttributedElement('video', { id: resourceKey, ...rest });
      }
      case 'file': {
        const { file_name, file_size } = segment.data;
        const resourceKey = newResourceKey(scope, 'file');
        files[resourceKey] = segment.data;
        return buildTaggedTextNode('file', file_name, { id: resourceKey, size: file_size });
      }
      case 'forward': {
        const { forward_id, title } = segment.data;
        // Every forward takes a key whether or not it is expanded, so its siblings keep their numbers.
        const resourceKey = newResourceKey(scope, 'forward');
        forwards[resourceKey] = segment.data;
        if (maxForwardDepth === 0) {
          return buildTaggedTextNode('forward', '(Forwarded message)', { id: resourceKey, title });
        }
        if (scope.forwardDepth > maxForwardDepth) {
          return buildTaggedTextNode('forward', '(Too deeply nested)', { id: resourceKey, title });
        }
        const forwardNode = buildAttributedElement('forward', { id: resourceKey, depth: scope.forwardDepth, title });

        // All nodes of this forward share one scope, numbered after the forward's own position.
        const innerScope: ResourceScope = {
          path: `${scope.path}.${scope.counts.forward}`,
          forwardDepth: scope.forwardDepth + 1,
          counts: createResourceCounts(),
        };
        const { messages: fwdMsgs } = await ctx.client.get_forwarded_messages({ forward_id });
        for (const fwdMsg of fwdMsgs) {
          const { sender_name, time } = fwdMsg;
          const fwdContentNode = buildAttributedElement('node', { sender_name, time });
          for (const fwdSegment of fwdMsg.segments) {
            const fwdElement = await buildElementFromSegment(fwdSegment, innerScope);
            if (fwdElement) {
              hp2.DomUtils.appendChild(fwdContentNode, fwdElement);
            }
          }
          hp2.DomUtils.appendChild(forwardNode, fwdContentNode);
        }

        return forwardNode;
      }
      case 'market_face': {
        const { summary } = segment.data;
        return buildTaggedTextNode('face', summary);
      }
      case 'light_app': {
        const parseResult = LightApp.safeParse(JSON.parse(segment.data.json_payload));
        if (parseResult.success) {
          const app = parseResult.data;
          switch (app.app) {
            case 'com.tencent.miniapp_01': {
              return buildPlainNode('miniapp', {
                type: 'miniapp',
                software: app.meta.detail_1.title ?? '',
                description: app.meta.detail_1.desc ?? '',
              });
            }
            case 'com.tencent.music.lua': {
              return buildPlainNode('music', {
                software: app.meta.music.tag ?? '',
                title: app.meta.music.title ?? '',
                artist: app.meta.music.desc ?? '',
              });
            }
            default: {
              // unreachable
              return null;
            }
          }
        } else {
          return buildTaggedTextNode('light_app', '(Invalid light app data)');
        }
      }
      case 'markdown': {
        return buildTaggedTextNode('markdown', segment.data.content);
      }
      case 'xml': {
        return buildTaggedTextNode('xml', segment.data.xml_payload);
      }
    }
    // return null;
  }

  const messageScope: ResourceScope = {
    path: String(message.message_seq),
    forwardDepth: 1,
    counts: createResourceCounts(),
  };
  for (const segment of message.segments) {
    const element = await buildElementFromSegment(segment, messageScope);
    if (element) {
      hp2.DomUtils.appendChild(contentNode, element);
    }
  }
  hp2.DomUtils.appendChild(root, contentNode);

  if ('friend' in message && message.friend) {
    hp2.DomUtils.appendChild(
      root,
      buildPlainNode('friend', {
        user_id: message.friend.user_id,
        nickname: message.friend.nickname,
        remark: message.friend.remark,
      }),
    );
  }
  if ('group' in message && message.group) {
    hp2.DomUtils.appendChild(
      root,
      buildPlainNode('group', {
        group_id: message.group.group_id,
        group_name: message.group.group_name,
      }),
    );
  }
  if ('group_member' in message && message.group_member) {
    hp2.DomUtils.appendChild(
      root,
      buildPlainNode('group_member', {
        user_id: message.group_member.user_id,
        card: message.group_member.card,
        nickname: message.group_member.nickname,
        role: message.group_member.role,
      }),
    );
  }

  return { node: root, resources, files, forwards };
}

export async function xmlify(
  ctx: Context,
  message: milky.IncomingMessage,
  options?: XmlifyOptions,
): Promise<XmlifyContext> {
  const { node, resources, files, forwards } = await xmlifyToElement(ctx, message, options);
  const serializeOptions = options?.serialize ?? {};
  const formatOptions = options?.format ?? {};
  const xml = render(node, {
    encodeEntities: 'utf8',
    ...serializeOptions,
  });
  return {
    xmlContent: formatXml(xml, {
      collapseContent: true,
      indentation: '  ',
      lineSeparator: '\n',
      ...formatOptions,
    }),
    resources,
    files,
    forwards,
  };
}

export async function xmlifyThread(
  ctx: Context,
  messages: milky.IncomingMessage[],
  options?: XmlifyOptions,
): Promise<XmlifyContext> {
  if (messages.length === 0) {
    throw new Error('No messages provided for xmlifyThread');
  }
  const threadNode = buildAttributedElement('thread', {
    scene: messages[0].message_scene,
    peer_id: messages[0].peer_id,
  });
  const resources: Record<string, { url: string }> = {};
  const files: Record<string, milky.IncomingFileSegment['data']> = {};
  const forwards: Record<string, milky.IncomingForwardSegment['data']> = {};
  for (const message of messages) {
    const {
      node,
      resources: msgResources,
      files: msgFiles,
      forwards: msgForwards,
    } = await xmlifyToElement(ctx, message, {
      ...options,
      inThread: true, // keys stay unique across the thread because each embeds its message seq
    });
    hp2.DomUtils.appendChild(threadNode, node);
    Object.assign(resources, msgResources);
    Object.assign(files, msgFiles);
    Object.assign(forwards, msgForwards);
  }
  const serializeOptions = options?.serialize ?? {};
  const formatOptions = options?.format ?? {};
  const xml = render(threadNode, {
    encodeEntities: 'utf8',
    ...serializeOptions,
  });
  return {
    xmlContent: formatXml(xml, {
      collapseContent: true,
      indentation: '  ',
      lineSeparator: '\n',
      ...formatOptions,
    }),
    resources,
    files,
    forwards,
  };
}
