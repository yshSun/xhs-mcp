/**
 * Tool schemas for XHS MCP Server
 */

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const XHS_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'xhs_auth_login',
    description: 'Start XiaoHongShu login process.',
    inputSchema: {
      type: 'object',
      properties: {
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
    },
  },
  {
    name: 'xhs_auth_logout',
    description: 'Logout from XiaoHongShu (clears saved cookies).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'xhs_auth_status',
    description: 'Check XiaoHongShu login status (fast check with browser).',
    inputSchema: {
      type: 'object',
      properties: {
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
    },
  },
  {
    name: 'xhs_discover_feeds',
    description: 'Get home page feed list.',
    inputSchema: {
      type: 'object',
      properties: {
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
    },
  },
  {
    name: 'xhs_search_note',
    description: 'Search for notes by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Search keyword (required)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'xhs_get_note_detail',
    description: 'Get detailed information about a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        feed_id: {
          type: 'string',
          description: 'Feed ID (required)',
        },
        xsec_token: {
          type: 'string',
          description: 'Security token for the feed (required)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['feed_id', 'xsec_token'],
    },
  },
  {
    name: 'xhs_comment_on_note',
    description: 'Comment on a note.',
    inputSchema: {
      type: 'object',
      properties: {
        feed_id: {
          type: 'string',
          description: 'Feed ID (required)',
        },
        xsec_token: {
          type: 'string',
          description: 'Security token for the feed (required)',
        },
        note: {
          type: 'string',
          description: 'Comment note (required)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['feed_id', 'xsec_token', 'note'],
    },
  },
  {
    name: 'xhs_publish_content',
    description: 'Publish content to XiaoHongShu (supports both images and videos).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['image', 'video'],
          description: 'Content type: "image" for images, "video" for videos (required)',
        },
        title: {
          type: 'string',
          description: 'Content title (required, max 20 characters)',
          maxLength: 20,
        },
        content: {
          type: 'string',
          description: 'Content description (required, max 1000 characters)',
          maxLength: 1000,
        },
        media_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of media file paths (required, non-empty). For images: 1-18 image files. For videos: exactly 1 video file.',
          maxItems: 18,
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags (optional)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['type', 'title', 'content', 'media_paths'],
    },
  },
  {
    name: 'xhs_get_user_notes',
    description: 'Get current user notes list.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of notes to fetch (default: 20)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for next page',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
    },
  },
  {
    name: 'xhs_delete_note',
    description: 'Delete a user note by ID or delete the last published note.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: 'Specific note ID to delete (optional if last_published is true)',
        },
        last_published: {
          type: 'boolean',
          description: 'Delete the last published note (optional if note_id is provided)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
    },
  },
  {
    name: 'xhs_download_note',
    description: 'Download a XiaoHongShu note - get detail info or download images/videos.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'XiaoHongShu note URL (required)',
        },
        mode: {
          type: 'string',
          enum: ['detail', 'download'],
          description: 'Mode: "detail" to get note info only, "download" to download files (default: detail)',
        },
        output_dir: {
          type: 'string',
          description: 'Output directory for downloaded files (default: ./downloads)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'xhs_get_user_profile',
    description: 'Get XiaoHongShu user profile and their notes. Supports profile URL, short link (xhslink.com), or XHS number (小红书号).',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'User profile URL, short link (xhslink.com/m/xxx), or XHS number (小红书号, e.g. 2658829639)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of notes to retrieve (default: 10)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'xhs_download_user_notes',
    description: 'Download notes from a XiaoHongShu user. Supports profile URL, short link, or XHS number. Includes delay between downloads to avoid rate limiting.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'User profile URL, short link (xhslink.com/m/xxx), or XHS number (小红书号)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of notes to download (default: 10, 0 for all)',
        },
        output_dir: {
          type: 'string',
          description: 'Output directory for downloaded files (default: ./downloads)',
        },
        delay: {
          type: 'number',
          description: 'Delay between downloads in milliseconds (default: 2000)',
        },
        browser_path: {
          type: 'string',
          description: 'Optional custom browser binary path',
        },
      },
      required: ['input'],
    },
  },
];

export const XHS_RESOURCE_SCHEMAS = [
  {
    uri: 'xhs://cookies',
    name: 'XHS Authentication Cookies',
    description: 'Current XiaoHongShu authentication cookies and info',
    mimeType: 'application/json',
  },
  {
    uri: 'xhs://config',
    name: 'XHS Server Configuration',
    description: 'XHS MCP server configuration',
    mimeType: 'application/json',
  },
  {
    uri: 'xhs://status',
    name: 'XHS Server Status',
    description: 'Current server and authentication status',
    mimeType: 'application/json',
  },
];
