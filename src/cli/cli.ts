#!/usr/bin/env node

/**
 * Unified CLI for XiaoHongShu operations
 */

import { Command } from 'commander';
import { getConfig } from '../shared/config';
import { AuthService } from '../core/auth/auth.service';
import puppeteer from 'puppeteer';
import { spawnSync } from 'node:child_process';
import { XHSMCPServer, XHSHTTPMCPServer } from '../server/index';
import { XHS_TOOL_SCHEMAS } from '../server/schemas/tool.schemas';
import { FeedService } from '../core/feeds/feed.service';
import { PublishService } from '../core/publishing/publish.service';
import { NoteService } from '../core/notes/note.service';
import { DownloadService, UserService, DownloadOptions } from '../core/downloading/index';

/**
 * CLI utility functions
 */
class CLIUtils {
  constructor(private program: Command) {}

  formatErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);

    // Handle specific error patterns
    if (/Executable doesn't exist|puppeteer browsers install/i.test(raw)) {
      return 'Chromium is not installed. Run: npx puppeteer browsers install chrome or xhs-mcp browser';
    }

    // For user-facing errors, just return the message without stack trace
    if (error instanceof Error) {
      // Check if it's a known error type that should show just the message
      if (
        error.message.includes('Either --note-id or --last-published must be specified') ||
        error.message.includes('Please specify either') ||
        error.message.includes('User not logged in') ||
        error.message.includes('Note not found') ||
        error.message.includes('Delete button not found')
      ) {
        return error.message;
      }

      // For other errors, show a cleaner version
      const condensed = raw
        .replace(
          /[\s\S]*?Looks like Puppeteer[\s\S]*?Please run the following command to download new browsers:[\s\S]*?npx puppeteer browsers install[\s\S]*?(Puppeteer Team[\s\S]*?)*?/m,
          ''
        )
        .replace(/[\u2500-\u257F]+/g, '') // box-drawing characters
        .replace(/\s+at\s+.*$/gm, '') // Remove stack trace lines
        .trim();

      return condensed || error.message;
    }

    return String(error);
  }

  writeJson(output: unknown, exitCode = 0): void {
    const compact = this.program.getOptionValue?.('compact') === true;
    const json = compact ? JSON.stringify(output) : JSON.stringify(output, null, 2);
    process.stdout.write(`${json}\n`);
    process.exit(exitCode);
  }

  printSuccess(result: unknown, message?: string): void {
    // If result already has success field, print it directly
    if (result && typeof result === 'object' && 'success' in result) {
      this.writeJson(result, 0);
    } else {
      // Otherwise, wrap it
      const payload = {
        success: true,
        message: message ?? (result as { message?: string })?.message ?? undefined,
        data: result,
      };
      this.writeJson(payload, 0);
    }
  }

  printError(error: unknown, code?: string): void {
    const message = this.formatErrorMessage(error);
    const payload = { success: false, message, code: code ?? undefined, status: 'error' } as const;
    this.writeJson(payload, 1);
  }

  printUsageError(command: string, message: string): void {
    const payload = {
      success: false,
      message,
      status: 'error',
      usage: `Use 'xhs-mcp ${command} --help' for more information`,
    } as const;
    this.writeJson(payload, 1);
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const program = new Command();
  const utils = new CLIUtils(program);

  program
    .name('xhs-mcp')
    .description('XiaoHongShu CLI with subcommands')
    .option('--compact', 'Output compact one-line JSON (no pretty print)')
    .showHelpAfterError();

  program
    .command('login')
    .description('Start XiaoHongShu login flow (opens browser, saves cookies)')
    .option('-t, --timeout <seconds>', 'Login timeout in seconds', `${config.browser.loginTimeout}`)
    .action(async (opts: { timeout?: string }) => {
      const browserPath = undefined;
      const timeoutSec = opts.timeout ? parseInt(opts.timeout, 10) : config.browser.loginTimeout;
      const authService = new AuthService(config);
      try {
        const result = await authService.login(browserPath, timeoutSec);
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  program
    .command('logout')
    .description('Logout from XiaoHongShu and clear saved cookies')
    .action(async () => {
      const authService = new AuthService(config);
      try {
        const result = await authService.logout();
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  program
    .command('status')
    .description('Check current XiaoHongShu login status')
    .action(async () => {
      const browserPath = undefined;
      const authService = new AuthService(config);
      try {
        const result = await authService.checkStatus(browserPath);
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  program
    .command('browser')
    .description('Ensure Puppeteer Chromium is installed and launchable; installs if missing')
    .option('--with-deps', 'Install OS-level dependencies as well (may require sudo)')
    .action(async (opts: { withDeps?: boolean }) => {
      async function canLaunchChromium(): Promise<{ canLaunch: boolean; executablePath?: string }> {
        try {
          // Get the executable path before launching
          const executablePath = puppeteer.executablePath();

          const browser = await puppeteer.launch({ headless: true });
          await browser.close();

          return { canLaunch: true, executablePath };
        } catch {
          return { canLaunch: false };
        }
      }

      const browserInfo = await canLaunchChromium();
      if (browserInfo.canLaunch) {
        utils.printSuccess(
          {
            installed: true,
            executablePath: browserInfo.executablePath,
          },
          'Chromium is ready'
        );
        return;
      }

      const args = ['puppeteer', 'browsers', 'install', 'chrome'];
      if (opts.withDeps) args.push('--with-deps');
      const result = spawnSync('npx', args, { stdio: 'inherit', env: process.env });

      const afterInstallInfo = await canLaunchChromium();
      if (afterInstallInfo.canLaunch) {
        utils.printSuccess(
          {
            installed: true,
            executablePath: afterInstallInfo.executablePath,
            exitCode: result.status ?? null,
          },
          'Chromium installed and ready'
        );
      } else {
        utils.printError(new Error('Failed to install or launch Chromium'));
      }
    });

  // Feeds: discover
  program
    .command('feeds')
    .description('Discover home page feeds')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(async (opts: { browserPath?: string }) => {
      const feedService = new FeedService(config);
      try {
        const result = await feedService.getFeedList(opts.browserPath);
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  // Feeds: search note
  program
    .command('search')
    .description('Search notes by keyword')
    .requiredOption('-k, --keyword <keyword>', 'Search keyword')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(async (opts: { keyword: string; browserPath?: string }) => {
      const feedService = new FeedService(config);
      try {
        const result = await feedService.searchFeeds(opts.keyword, opts.browserPath);
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  // User Notes: unified command with subcommands
  const userNoteCommand = program
    .command('usernote')
    .description("Current user's note management operations");

  // User Note list subcommand
  userNoteCommand
    .command('list')
    .description("List current user's published notes")
    .option('-l, --limit <number>', 'Maximum number of notes to retrieve', '20')
    .option('-c, --cursor <cursor>', 'Pagination cursor for next page')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(async (opts: { limit: string; cursor?: string; browserPath?: string }) => {
      const noteService = new NoteService(config);
      try {
        const limit = parseInt(opts.limit) || 20;
        const result = await noteService.getUserNotes(limit, opts.cursor, opts.browserPath);
        utils.printSuccess(result);
      } catch (error) {
        utils.printError(error);
      }
    });

  // User Note delete subcommand
  userNoteCommand
    .command('delete')
    .description('Delete user notes')
    .option('--note-id <id>', 'Specific note ID to delete')
    .option('--last-published', 'Delete the last published note')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(async (opts: { noteId?: string; lastPublished?: boolean; browserPath?: string }) => {
      const noteService = new NoteService(config);
      try {
        if (opts.lastPublished) {
          const result = await noteService.deleteLastPublishedNote(opts.browserPath);
          utils.printSuccess(result);
        } else if (opts.noteId) {
          const result = await noteService.deleteNote(opts.noteId, opts.browserPath);
          utils.printSuccess(result);
        } else {
          // Show help instead of JSON error when no arguments provided
          console.log('Usage: xhs-mcp usernote delete [options]\n');
          console.log('Delete user notes\n');
          console.log('Options:');
          console.log('  --note-id <id>             Specific note ID to delete');
          console.log('  --last-published           Delete the last published note');
          console.log('  -b, --browser-path <path>  Custom browser binary path');
          console.log('  -h, --help                 display help for command');
          process.exit(0);
        }
      } catch (error) {
        utils.printError(error);
      }
    });

  // Feeds: comment on note
  program
    .command('comment')
    .description('Comment on a note')
    .requiredOption('--feed-id <id>', 'Feed ID')
    .requiredOption('--xsec-token <token>', 'Security token for the feed')
    .requiredOption('-n, --note <text>', 'Comment content')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(
      async (opts: { feedId: string; xsecToken: string; note: string; browserPath?: string }) => {
        const feedService = new FeedService(config);
        try {
          const result = await feedService.commentOnFeed(
            opts.feedId,
            opts.xsecToken,
            opts.note,
            opts.browserPath
          );
          utils.printSuccess(result);
        } catch (error) {
          utils.printError(error);
        }
      }
    );

  // Publishing: unified publish command
  program
    .command('publish')
    .description('Publish content to XiaoHongShu (supports both images and videos)')
    .requiredOption('-t, --type <type>', 'Content type: "image" for images, "video" for videos')
    .requiredOption('--title <title>', 'Content title (<= 20 chars)')
    .requiredOption('--content <content>', 'Content description (<= 1000 chars)')
    .requiredOption(
      '-m, --media <paths>',
      'Comma-separated media file paths (1-18 images for image posts, exactly 1 video for videos)'
    )
    .option('--tags <tags>', 'Comma-separated tags')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(
      async (opts: {
        type: string;
        title: string;
        content: string;
        media: string;
        tags?: string;
        browserPath?: string;
      }) => {
        const publishService = new PublishService(config);
        try {
          if (opts.type !== 'image' && opts.type !== 'video') {
            utils.printError(new Error('Type must be "image" or "video"'));
            return;
          }

          const mediaPaths = opts.media
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const result = await publishService.publishContent(
            opts.type,
            opts.title,
            opts.content,
            mediaPaths,
            opts.tags,
            opts.browserPath
          );
          utils.printSuccess(result);
        } catch (error) {
          utils.printError(error);
        }
      }
    );

  // Download: get note detail or download note files
  program
    .command('download')
    .description('Download XiaoHongShu note (get detail or download files)')
    .requiredOption('-u, --url <url>', 'XiaoHongShu note URL')
    .option('-o, --output <directory>', 'Output directory for downloaded files', './downloads')
    .option('-m, --mode <mode>', 'Mode: "detail" to get note info only, "download" to download files', 'detail')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(
      async (opts: {
        url: string;
        output: string;
        mode: string;
        browserPath?: string;
      }) => {
        const downloadService = new DownloadService(config);
        try {
          if (opts.mode === 'detail') {
            // Get note detail only
            const result = await downloadService.getNoteDetail(opts.url, opts.browserPath);
            utils.printSuccess(result);
          } else if (opts.mode === 'download') {
            // Download note files
            const result = await downloadService.downloadNote(opts.url, opts.output, opts.browserPath);
            utils.printSuccess(result);
          } else {
            utils.printError(new Error('Mode must be "detail" or "download"'));
          }
        } catch (error) {
          utils.printError(error);
        }
      }
    );

  // User: get user profile and notes
  program
    .command('user')
    .description('Get XiaoHongShu user profile and their notes')
    .requiredOption('-i, --input <input>', 'User profile URL, short link, or xhs number (小红书号)')
    .option('-l, --limit <number>', 'Maximum number of notes to retrieve/download', '10')
    .option('-o, --output <directory>', 'Output directory for downloaded files (only for download mode)', './downloads')
    .option('-m, --mode <mode>', 'Mode: "list" to get note list only, "download" to download notes', 'list')
    .option('-d, --delay <milliseconds>', 'Delay between downloads in milliseconds (default: 2000)', '2000')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(
      async (opts: {
        input: string;
        limit: string;
        output: string;
        mode: string;
        delay: string;
        browserPath?: string;
      }) => {
        const userService = new UserService(config);
        const downloadService = new DownloadService(config);
        try {
          const limit = parseInt(opts.limit, 10) || 10;
          const delay = parseInt(opts.delay, 10) || 2000;

          // Get user profile and notes
          const result = await userService.getUserProfile(opts.input, limit, opts.browserPath);

          if (!result.success) {
            utils.printError(new Error(result.message || 'Failed to get user profile'));
            return;
          }

          if (opts.mode === 'list') {
            // Just output the note list
            utils.printSuccess({
              success: true,
              profile: result.profile,
              notes: result.notes,
              totalNotes: result.notes.length,
            });
          } else if (opts.mode === 'download') {
            // Download notes with delay
            const downloadOptions: DownloadOptions = {
              outputDir: opts.output,
              delay: delay,
              limit: limit,
              browserPath: opts.browserPath,
              onProgress: (current, total, noteTitle) => {
                console.log(`[${current}/${total}] Downloading: ${noteTitle}`);
              },
            };

            const downloadResult = await downloadService.batchDownloadNotes(
              result.notes,
              downloadOptions
            );

            utils.printSuccess({
              success: downloadResult.success,
              profile: result.profile,
              totalNotes: downloadResult.totalNotes,
              downloadedCount: downloadResult.downloadedCount,
              failedCount: downloadResult.failedCount,
              files: downloadResult.files,
              errors: downloadResult.errors.length > 0 ? downloadResult.errors : undefined,
            });
          } else {
            utils.printError(new Error('Mode must be "list" or "download"'));
          }
        } catch (error) {
          utils.printError(error);
        }
      }
    );

  // User Links: get user profile note links only
  program
    .command('user-links')
    .description('Get XiaoHongShu user profile note links only')
    .requiredOption('-i, --input <input>', 'User profile URL, short link, or xhs number (小红书号)')
    .option('-l, --limit <number>', 'Maximum number of note links to retrieve', '20')
    .option('-n, --first-n <number>', 'Get first N notes only (takes precedence over -l if specified)')
    .option('-b, --browser-path <path>', 'Custom browser binary path')
    .action(
      async (opts: {
        input: string;
        limit: string;
        firstN?: string;
        browserPath?: string;
      }) => {
        const userService = new UserService(config);
        try {
          // Determine the limit: if -n is specified, use that; otherwise use -l
          let limit = 20; // default
          if (opts.firstN) {
            limit = parseInt(opts.firstN, 10);
            if (isNaN(limit) || limit <= 0) {
              utils.printError(new Error('First N value must be a positive integer'));
              return;
            }
          } else {
            limit = parseInt(opts.limit, 10) || 20;
          }

          // Get user profile and note links
          const result = await userService.getUserNoteLinks(opts.input, limit, opts.browserPath);

          if (!result.success) {
            utils.printError(new Error(result.message || 'Failed to get user note links'));
            return;
          }

          // Output the note links
          utils.printSuccess({
            success: true,
            profile: result.profile,
            noteLinks: result.noteLinks,
            totalLinks: result.noteLinks.length,
          });
        } catch (error) {
          utils.printError(error);
        }
      }
    );

  program
    .command('mcp')
    .description('Start XHS MCP server (stdio or http mode)')
    .option('-m, --mode <mode>', 'Server mode: stdio or http', 'stdio')
    .option('-p, --port <port>', 'HTTP server port (only for http mode)', '3000')
    .action(async (opts: { mode?: string; port?: string }) => {
      try {
        if (opts.mode === 'http') {
          const port = opts.port ? parseInt(opts.port, 10) : 3000;
          const httpServer = new XHSHTTPMCPServer(port);
          await httpServer.start();
        } else {
          // In stdio mode, we must not output anything to stdout/stderr except MCP protocol messages
          // This prevents interference with MCP communication
          const server = new XHSMCPServer();
          await server.start();
        }
      } catch (error) {
        // Only log to stderr if logging is explicitly enabled
        if (process.env.XHS_ENABLE_LOGGING === 'true') {
          process.stderr.write(`Server failed to start: ${error}\n`);
        }
        process.exit(1);
      }
    });

  // List MCP tools
  program
    .command('tools')
    .description('List available MCP tools')
    .option('-j, --json', 'Output in JSON format')
    .option('-d, --detailed', 'Show detailed tool information')
    .action(async (opts: { json?: boolean; detailed?: boolean }) => {
      try {
        const toolSchemas = XHS_TOOL_SCHEMAS;

        if (opts.json) {
          if (opts.detailed) {
            console.log(JSON.stringify(toolSchemas, null, 2));
          } else {
            const toolNames = toolSchemas.map((tool) => ({
              name: tool.name,
              description: tool.description,
            }));
            console.log(JSON.stringify(toolNames, null, 2));
          }
        } else {
          console.log('\n📋 Available MCP Tools:\n');

          toolSchemas.forEach((tool, index) => {
            console.log(`${index + 1}. ${tool.name}`);
            console.log(`   ${tool.description}`);

            if (opts.detailed) {
              const required = tool.inputSchema.required ?? [];
              const properties = tool.inputSchema.properties ?? {};

              if (Object.keys(properties).length > 0) {
                console.log('   Parameters:');
                Object.entries(properties).forEach(([key, prop]: [string, unknown]) => {
                  const requiredMark = required.includes(key) ? ' (required)' : ' (optional)';
                  const propDesc = (prop as { description?: string }).description;
                  console.log(`     - ${key}: ${propDesc ?? 'No description'}${requiredMark}`);
                });
              }
            }
            console.log('');
          });

          console.log(`Total: ${toolSchemas.length} tools available`);
          console.log('\nUse --detailed for parameter information');
          console.log('Use --json for machine-readable output');
        }
      } catch (error) {
        utils.printError(error);
      }
    });

  program.parseAsync(process.argv);
}

// Handle graceful shutdown for MCP server mode
process.on('SIGINT', () => {
  // Don't log to stderr in stdio mode to avoid interfering with MCP protocol
  process.exit(0);
});

process.on('SIGTERM', () => {
  // Don't log to stderr in stdio mode to avoid interfering with MCP protocol
  process.exit(0);
});

// Start the CLI
main().catch((error) => {
  // Only log to stderr if logging is explicitly enabled
  if (process.env.XHS_ENABLE_LOGGING === 'true') {
    process.stderr.write(`Fatal error: ${error}\n`);
  }
  process.exit(1);
});
