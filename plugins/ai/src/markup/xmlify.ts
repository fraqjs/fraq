import type { Context, milky } from '@fraqjs/fraq';
import render, { type DomSerializerOptions } from 'dom-serializer';
import { Element, Text } from 'domhandler';
import * as hp2 from 'htmlparser2';
import formatXml, { type XMLFormatterOptions } from 'xml-formatter';

export interface XmlifyOptions {
  maxForwardDepth?: number;
  serialize?: DomSerializerOptions;
  format?: XMLFormatterOptions;
  resourceIndex?: ResourceIndex;
}

export interface ResourceIndex {
  image: number;
  record: number;
  video: number;
  file: number;
  forward: number;
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

export function createResourceIndex(): ResourceIndex {
  return { image: 0, record: 0, video: 0, file: 0, forward: 0 };
}

export async function xmlifyToElement(ctx: Context, message: milky.IncomingMessage, options?: XmlifyOptions) {
  const maxForwardDepth = options?.maxForwardDepth ?? 0;
  const inThread = options?.resourceIndex !== undefined;
  const resourceIndex: ResourceIndex = options?.resourceIndex ?? createResourceIndex();

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
  function newResourceKey(type: keyof ResourceIndex): string {
    resourceIndex[type]++;
    return `${type}${resourceIndex[type]}`;
  }

  async function buildElementFromSegment(
    segment: milky.IncomingSegment,
    forwardDepth: number = 1,
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
        return buildAttributedElement('face', segment.data);
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
        const resourceKey = newResourceKey('image');
        const imageNode = buildTaggedTextNode('image', summary, { id: resourceKey, ...rest });
        resources[resourceKey] = { url: segment.data.temp_url };
        return imageNode;
      }
      case 'record': {
        const { resource_id, temp_url, ...rest } = segment.data;
        const resourceKey = newResourceKey('record');
        resources[resourceKey] = { url: segment.data.temp_url };
        return buildAttributedElement('record', { id: resourceKey, ...rest });
      }
      case 'video': {
        const { resource_id, temp_url, ...rest } = segment.data;
        const resourceKey = newResourceKey('video');
        resources[resourceKey] = { url: segment.data.temp_url };
        return buildAttributedElement('video', { id: resourceKey, ...rest });
      }
      case 'file': {
        const { file_name, file_size } = segment.data;
        const resourceKey = newResourceKey('file');
        files[resourceKey] = segment.data;
        return buildTaggedTextNode('file', file_name, { id: resourceKey, size: file_size });
      }
      case 'forward': {
        const { forward_id, title } = segment.data;
        if (maxForwardDepth === 0) {
          const resourceKey = newResourceKey('forward');
          forwards[resourceKey] = segment.data;
          return buildTaggedTextNode('forward', '(Forwarded message)', { id: resourceKey, title });
        }
        if (forwardDepth > maxForwardDepth) {
          const resourceKey = newResourceKey('forward');
          forwards[resourceKey] = segment.data;
          return buildTaggedTextNode('forward', '(Too deeply nested)', { id: resourceKey, title });
        }
        const forwardNode = buildAttributedElement('forward', { depth: forwardDepth, title });

        const { messages: fwdMsgs } = await ctx.client.get_forwarded_messages({ forward_id });
        for (const fwdMsg of fwdMsgs) {
          const { sender_name, time } = fwdMsg;
          const fwdContentNode = buildAttributedElement('node', { sender_name, time });
          for (const fwdSegment of fwdMsg.segments) {
            const fwdElement = await buildElementFromSegment(fwdSegment, forwardDepth + 1);
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
    }
    return null;
  }

  for (const segment of message.segments) {
    const element = await buildElementFromSegment(segment);
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

export async function xmlifyThread(ctx: Context, messages: milky.IncomingMessage[], options?: XmlifyOptions) {
  if (messages.length === 0) {
    throw new Error('No messages provided for xmlifyThread');
  }
  const threadNode = buildAttributedElement('thread', {
    scene: messages[0].message_scene,
    peer_id: messages[0].peer_id,
  });
  const resourceIndex: ResourceIndex = options?.resourceIndex ?? createResourceIndex();
  const resources: Record<string, { url: string }> = {};
  const files: Record<string, milky.IncomingFileSegment['data']> = {};
  for (const message of messages) {
    const {
      node,
      resources: msgResources,
      files: msgFiles,
    } = await xmlifyToElement(ctx, message, {
      ...options,
      resourceIndex, // reuse across all messages in the thread to ensure unique resource keys
    });
    hp2.DomUtils.appendChild(threadNode, node);
    Object.assign(resources, msgResources);
    Object.assign(files, msgFiles);
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
  };
}
