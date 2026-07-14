import type { ApiEndpointName, Context } from '@fraqjs/fraq';
import type { HonoService } from '@fraqjs/plugin-hono';

const API_ENDPOINT_NAMES = new Set<string>([
  'get_login_info',
  'get_impl_info',
  'get_user_profile',
  'get_friend_list',
  'get_friend_info',
  'get_group_list',
  'get_group_info',
  'get_group_member_list',
  'get_group_member_info',
  'get_peer_pins',
  'set_peer_pin',
  'set_avatar',
  'set_nickname',
  'set_bio',
  'get_custom_face_url_list',
  'get_cookies',
  'get_csrf_token',
  'send_private_message',
  'send_group_message',
  'recall_private_message',
  'recall_group_message',
  'get_message',
  'get_history_messages',
  'get_resource_temp_url',
  'get_forwarded_messages',
  'mark_message_as_read',
  'send_friend_nudge',
  'send_profile_like',
  'delete_friend',
  'get_friend_requests',
  'accept_friend_request',
  'reject_friend_request',
  'set_group_name',
  'set_group_avatar',
  'set_group_member_card',
  'set_group_member_special_title',
  'set_group_member_admin',
  'set_group_member_mute',
  'set_group_whole_mute',
  'kick_group_member',
  'get_group_announcements',
  'send_group_announcement',
  'delete_group_announcement',
  'get_group_essence_messages',
  'set_group_essence_message',
  'quit_group',
  'send_group_message_reaction',
  'send_group_nudge',
  'get_group_notifications',
  'accept_group_request',
  'reject_group_request',
  'accept_group_invitation',
  'reject_group_invitation',
  'upload_private_file',
  'upload_group_file',
  'get_private_file_download_url',
  'get_group_file_download_url',
  'get_group_files',
  'move_group_file',
  'rename_group_file',
  'delete_group_file',
  'persist_group_file',
  'create_group_folder',
  'rename_group_folder',
  'delete_group_folder',
] as const satisfies readonly ApiEndpointName[]);

export function registerApiEndpoint(ctx: Context, hono: HonoService, prefix: string, accessToken?: string): void {
  hono.app.post(`${prefix}/api/:api`, async (c) => {
    if (accessToken) {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (token !== accessToken) {
        return c.json({ status: 'failed', retcode: -401, message: 'Unauthorized' }, 401);
      }
    }

    const contentType = c.req.header('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      return c.json({ status: 'failed', retcode: -415, message: 'Unsupported Content-Type' }, 415);
    }

    const apiName = c.req.param('api');
    if (!API_ENDPOINT_NAMES.has(apiName)) {
      return c.json({ status: 'failed', retcode: -404, message: `API ${apiName} not found` }, 404);
    }

    let params: unknown;
    try {
      params = await c.req.json();
    } catch {
      return c.json({ status: 'failed', retcode: -400, message: 'Invalid JSON body' });
    }

    try {
      const client = ctx.client as unknown as Record<string, (params?: unknown) => Promise<unknown>>;
      const data = await client[apiName](params);
      return c.json({ status: 'ok', retcode: 0, data: data ?? {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ status: 'failed', retcode: -500, message });
    }
  });

  ctx.logger.info(`Milky API endpoint registered at ${prefix}/api/:api`);
}
