import type { Context, milky } from '@fraqjs/fraq';
import render, { type DomSerializerOptions } from 'dom-serializer';
import { Element, Text } from 'domhandler';
import * as hp2 from 'htmlparser2';
import formatXml, { type XMLFormatterOptions } from 'xml-formatter';

export interface XmlifyOptions {
  maxForwardDepth?: number;
  serialize?: DomSerializerOptions;
  format?: XMLFormatterOptions;
}

export interface XmlifyContext {
  xmlContent: string;
  resources: Record<string, { url: string }>;
  files: Record<string, milky.IncomingFileSegment['data']>;
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

function buildPlainXmlNode(name: string, values: object) {
  const element = new Element(name, {});
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'object' && value !== null) {
      hp2.DomUtils.appendChild(element, buildPlainXmlNode(key, value));
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      hp2.DomUtils.appendChild(element, new Element(key, {}, [new Text(String(value))]));
    }
  }
  return element;
}

function buildAttributedXmlNode(name: string, values: object) {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = String(value);
    }
  }
  return new Element(name, attrs);
}

function buildTaggedTextNode(tag: string, text: string, attrs?: object) {
  const element = attrs ? buildAttributedXmlNode(tag, attrs) : new Element(tag, {});
  hp2.DomUtils.appendChild(element, new Text(text));
  return element;
}

export async function xmlify(
  ctx: Context,
  message: milky.IncomingMessage,
  options?: XmlifyOptions,
): Promise<XmlifyContext> {
  const maxForwardDepth = options?.maxForwardDepth ?? 0;
  const serializeOptions = options?.serialize ?? {};
  const formatOptions = options?.format ?? {};

  const root = new Element('message', {
    scene: message.message_scene,
    peer_id: message.peer_id.toString(),
    seq: message.message_seq.toString(),
    sender_id: message.sender_id.toString(),
    time: message.time.toString(),
  });

  const contentNode = new Element('content', {});
  const resources: Record<string, { url: string }> = {};
  const files: Record<string, milky.IncomingFileSegment['data']> = {};
  const resourceCount = {
    image: 0,
    record: 0,
    video: 0,
  };
  function newResourceKey(type: 'image' | 'record' | 'video') {
    resourceCount[type]++;
    return `${type}${resourceCount[type]}`;
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
        return buildAttributedXmlNode('face', segment.data);
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
        return buildAttributedXmlNode('record', { id: resourceKey, ...rest });
      }
      case 'video': {
        const { resource_id, temp_url, ...rest } = segment.data;
        const resourceKey = newResourceKey('video');
        resources[resourceKey] = { url: segment.data.temp_url };
        return buildAttributedXmlNode('video', { id: resourceKey, ...rest });
      }
      case 'file': {
        const { file_name, file_size } = segment.data;
        const fileNode = buildTaggedTextNode('file', file_name, { size: file_size });
        files[file_name] = segment.data;
        return fileNode;
      }
      case 'forward': {
        if (maxForwardDepth === 0) {
          return buildTaggedTextNode('forward', '(Forwarded message)', { title: segment.data.title });
        }

        const { forward_id, title } = segment.data;
        if (forwardDepth > maxForwardDepth) {
          return buildTaggedTextNode('forward', '(Too deeply nested)', { title });
        }
        const forwardNode = buildAttributedXmlNode('forward', { depth: forwardDepth, title });

        const { messages: fwdMsgs } = await ctx.client.get_forwarded_messages({ forward_id });
        for (const fwdMsg of fwdMsgs) {
          const { sender_name, time } = fwdMsg;
          const fwdContentNode = buildAttributedXmlNode('node', { sender_name, time });
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
      buildPlainXmlNode('friend', {
        user_id: message.friend.user_id,
        nickname: message.friend.nickname,
        remark: message.friend.remark,
      }),
    );
  }
  if ('group' in message && message.group) {
    hp2.DomUtils.appendChild(
      root,
      buildPlainXmlNode('group', {
        group_id: message.group.group_id,
        group_name: message.group.group_name,
      }),
    );
  }
  if ('group_member' in message && message.group_member) {
    hp2.DomUtils.appendChild(
      root,
      buildPlainXmlNode('group_member', {
        user_id: message.group_member.user_id,
        card: message.group_member.card,
        nickname: message.group_member.nickname,
        role: message.group_member.role,
      }),
    );
  }

  const xml = render(root, { encodeEntities: 'utf8', ...serializeOptions });
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
