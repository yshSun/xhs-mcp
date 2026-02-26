/**
 * Download service for XHS MCP Server
 * Provides functionality to fetch and download XiaoHongShu notes
 */

import { Page } from 'puppeteer';
import { Config, NoteDetailResult } from '../../shared/types';
import { DownloadError } from '../../shared/errors';
import { BaseService } from '../../shared/base.service';
import { logger } from '../../shared/logger';
import { sleep } from '../../shared/utils';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Download options interface
export interface DownloadOptions {
  /** Output directory for downloaded files */
  outputDir: string;
  /** Delay between downloads in milliseconds (default: 2000) */
  delay?: number;
  /** Maximum number of notes to download (0 = all) */
  limit?: number;
  /** Custom browser path */
  browserPath?: string;
  /** Progress callback */
  onProgress?: (current: number, total: number, noteTitle: string) => void;
}

// Batch download result
export interface BatchDownloadResult {
  success: boolean;
  totalNotes: number;
  downloadedCount: number;
  failedCount: number;
  files: string[];
  errors: Array<{ noteId: string; title: string; error: string }>;
}

// Note data interface
interface NoteData {
  noteId: string;
  title: string;
  desc: string;
  type: 'video' | 'normal';
  imageList: ImageItem[];
  videoUrl?: string;
  user: {
    userId: string;
    nickname: string;
  };
  interactInfo: {
    likedCount: string;
    collectedCount: string;
    commentCount: string;
    shareCount: string;
  };
  tagList: Array<{ name: string }>;
  time: number;
  lastUpdateTime: number;
}

interface ImageItem {
  url: string;
  urlDefault: string;
  stream?: {
    h264?: Array<{ masterUrl: string }>;
  };
}

export class DownloadService extends BaseService {
  constructor(config: Config) {
    super(config);
  }

  /**
   * Get note detail data from URL (without downloading)
   */
  async getNoteDetail(
    url: string,
    browserPath?: string
  ): Promise<NoteDetailResult> {
    try {
      // Create page with cookies loaded (third param = shouldLoadCookies = true)
      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        // Check if it's a short link and resolve it first
        let resolvedUrl = url;
        if (url.includes('xhslink.com')) {
          const shortUrl = url.startsWith('http') ? url : `https://${url}`;
          logger.debug(`Resolving short link: ${shortUrl}`);

          // Navigate to short link and wait for redirect
          await page.goto(shortUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await sleep(3000);
          resolvedUrl = page.url();
          logger.debug(`Short link resolved to: ${resolvedUrl}`);
        } else {
          // Navigate to the note URL
          await this.getBrowserManager().navigateWithRetry(page, url);
          await sleep(3000);
        }

        // Debug: log page URL and title
        const pageInfo = await page.evaluate(() => {
          const win = window as any;
          return {
            url: window.location.href,
            title: document.title,
            hasInitialState: !!win.__INITIAL_STATE__,
            hasInitialData: !!win.__INITIAL_DATA__,
            bodyLength: document.body.innerHTML.length,
          };
        });
        logger.debug(`Page info: ${JSON.stringify(pageInfo)}`);

        // Extract note data from page
        const noteData = await this.extractNoteData(page);

        if (!noteData) {
          throw new DownloadError('Failed to extract note data from page');
        }

        logger.debug(`Note data extracted: ${JSON.stringify({
          noteId: noteData.noteId,
          title: noteData.title,
          imageListLength: noteData.imageList?.length,
          firstImage: noteData.imageList?.[0],
        })}`);

        // Extract image/video URLs
        const { imageUrls, videoUrl, liveUrls } = this.extractMediaUrls(noteData);

        return {
          success: true,
          noteId: noteData.noteId,
          title: noteData.title || '',
          desc: noteData.desc || '',
          type: noteData.type === 'video' ? 'video' : 'image',
          author: {
            userId: noteData.user?.userId || '',
            nickname: noteData.user?.nickname || '',
          },
          imageUrls,
          videoUrl,
          liveUrls,
          interactInfo: {
            likedCount: noteData.interactInfo?.likedCount || '0',
            collectedCount: noteData.interactInfo?.collectedCount || '0',
            commentCount: noteData.interactInfo?.commentCount || '0',
            shareCount: noteData.interactInfo?.shareCount || '0',
          },
          tags: noteData.tagList?.map((t: any) => t.name).join(' ') || '',
          time: noteData.time || 0,
          lastUpdateTime: noteData.lastUpdateTime || 0,
          url: resolvedUrl,
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Get note detail error: ${error}`);
      throw new DownloadError(`Failed to get note detail: ${error}`);
    }
  }

  /**
   * Download note images/videos to local folder
   * Uses author nickname to organize files by author
   */
  async downloadNote(
    url: string,
    outputDir: string,
    browserPath?: string
  ): Promise<{ success: boolean; message: string; files: string[] }> {
    try {
      // Get note detail first
      const noteDetail = await this.getNoteDetail(url, browserPath);

      if (!noteDetail.success) {
        throw new DownloadError('Failed to get note detail');
      }

      // Create output directory with author name subfolder
      const authorName = noteDetail.author.nickname || 'unknown';
      const safeAuthorName = sanitizeFileName(authorName);
      const authorOutputDir = join(outputDir, safeAuthorName);

      // Ensure output directory exists
      if (!existsSync(authorOutputDir)) {
        mkdirSync(authorOutputDir, { recursive: true });
      }

      const downloadedFiles: string[] = [];

      // Download images
      if (noteDetail.imageUrls && noteDetail.imageUrls.length > 0) {
        for (let i = 0; i < noteDetail.imageUrls.length; i++) {
          const imageUrl = noteDetail.imageUrls[i];
          const ext = this.getImageExtension(imageUrl);
          const filename = `image_${i + 1}.${ext}`;
          const filepath = join(authorOutputDir, filename);

          try {
            await this.downloadFile(imageUrl, filepath);
            downloadedFiles.push(filepath);
            logger.debug(`Downloaded image: ${filename}`);
          } catch (error) {
            logger.warn(`Failed to download image ${imageUrl}: ${error}`);
          }
        }
      }

      // Download video
      if (noteDetail.videoUrl) {
        const filename = 'video.mp4';
        const filepath = join(authorOutputDir, filename);

        try {
          await this.downloadFile(noteDetail.videoUrl, filepath);
          downloadedFiles.push(filepath);
          logger.debug(`Downloaded video: ${filename}`);
        } catch (error) {
          logger.warn(`Failed to download video ${noteDetail.videoUrl}: ${error}`);
        }
      }

      // Save note metadata as JSON
      const metadataPath = join(authorOutputDir, 'metadata.json');
      const metadata = {
        noteId: noteDetail.noteId,
        title: noteDetail.title,
        desc: noteDetail.desc,
        type: noteDetail.type,
        author: noteDetail.author,
        interactInfo: noteDetail.interactInfo,
        tags: noteDetail.tags,
        time: noteDetail.time,
        url: noteDetail.url,
        downloadedFiles: downloadedFiles.map((f) => basename(f)),
      };
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      downloadedFiles.push(metadataPath);

      return {
        success: true,
        message: `Downloaded ${downloadedFiles.length} files`,
        files: downloadedFiles,
      };
    } catch (error) {
      logger.error(`Download note error: ${error}`);
      throw new DownloadError(`Failed to download note: ${error}`);
    }
  }

  /**
   * Batch download multiple notes with delay between downloads
   * @param notes - Array of note objects with url and title
   * @param options - Download options including output directory and delay
   */
  async batchDownloadNotes(
    notes: Array<{ noteId: string; title: string; url: string }>,
    options: DownloadOptions
  ): Promise<BatchDownloadResult> {
    const { outputDir, delay = 2000, limit = 0, browserPath, onProgress } = options;

    // Apply limit if specified
    const notesToDownload = limit > 0 ? notes.slice(0, limit) : notes;
    const totalNotes = notesToDownload.length;

    const result: BatchDownloadResult = {
      success: true,
      totalNotes,
      downloadedCount: 0,
      failedCount: 0,
      files: [],
      errors: [],
    };

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    for (let i = 0; i < notesToDownload.length; i++) {
      const note = notesToDownload[i];
      const current = i + 1;

      // Progress callback
      if (onProgress) {
        onProgress(current, totalNotes, note.title);
      }

      logger.info(`Downloading note ${current}/${totalNotes}: ${note.title}`);

      try {
        const downloadResult = await this.downloadNote(note.url, outputDir, browserPath);
        result.files.push(...downloadResult.files);
        result.downloadedCount++;

        // Add delay between downloads to avoid rate limiting
        if (i < notesToDownload.length - 1 && delay > 0) {
          logger.debug(`Waiting ${delay}ms before next download...`);
          await sleep(delay);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to download note ${note.noteId}: ${errorMessage}`);
        result.failedCount++;
        result.errors.push({
          noteId: note.noteId,
          title: note.title,
          error: errorMessage,
        });
      }
    }

    // Update success status if any downloads failed
    if (result.failedCount > 0) {
      result.success = result.downloadedCount > 0;
    }

    return result;
  }

  /**
   * Extract note data from page
   */
  private async extractNoteData(page: Page): Promise<NoteData | null> {
    try {
      const noteData = await page.evaluate(`
        (() => {
          const win = window;
          // Try to get data from win.__INITIAL_STATE__
          const initialState = win.__INITIAL_STATE__;
          if (initialState) {
            // PC path: note -> noteDetailMap -> first key -> note
            if (initialState.note && initialState.note.noteDetailMap) {
              const noteDetailMap = initialState.note.noteDetailMap;
              const keys = Object.keys(noteDetailMap);
              if (keys.length > 0) {
                const firstKey = keys[0];
                const noteData = noteDetailMap[firstKey];
                if (noteData && noteData.note) {
                  return noteData.note;
                }
              }
            }

            // Phone path: noteData -> data -> noteData
            if (initialState.noteData && initialState.noteData.data && initialState.noteData.data.noteData) {
              return initialState.noteData.data.noteData;
            }
          }

          // Try to get data from win.__INITIAL_DATA__
          if (win.__INITIAL_DATA__) {
            return win.__INITIAL_DATA__;
          }

          // Try to find data in page data
          const dataElements = document.querySelectorAll('[id^="__NEXT_DATA__"], script[type="application/json"]');
          for (const el of dataElements) {
            try {
              const text = el.textContent;
              if (text) {
                const data = JSON.parse(text);
                // Check props.pageProps
                if (data.props && data.props.pageProps) {
                  const pageProps = data.props.pageProps;
                  // Try PC path
                  if (pageProps.note && pageProps.note.noteDetailMap) {
                    const noteDetailMap = pageProps.note.noteDetailMap;
                    const keys = Object.keys(noteDetailMap);
                    if (keys.length > 0) {
                      const firstKey = keys[0];
                      const noteData = noteDetailMap[firstKey];
                      if (noteData && noteData.note) {
                        return noteData.note;
                      }
                    }
                  }
                  // Try phone path
                  if (pageProps.noteData && pageProps.noteData.data && pageProps.noteData.data.noteData) {
                    return pageProps.noteData.data.noteData;
                  }
                }
              }
            } catch (e) {
              // Continue to next element
            }
          }

          return null;
        })()
      `);

      return noteData as NoteData | null;
    } catch (error) {
      logger.error(`Failed to extract note data: ${error}`);
      return null;
    }
  }

  /**
   * Extract media URLs from note data
   */
  private extractMediaUrls(noteData: NoteData): {
    imageUrls: string[];
    videoUrl?: string;
    liveUrls: string[];
  } {
    const imageUrls: string[] = [];
    const liveUrls: string[] = [];

    // Extract images
    if (noteData.imageList && noteData.imageList.length > 0) {
      for (const img of noteData.imageList) {
        // Try urlDefault first, then url
        const imageUrl = img.urlDefault || img.url;
        if (imageUrl) {
          const formattedUrl = this.formatImageUrl(imageUrl);
          imageUrls.push(formattedUrl);
        }

        // Extract live photo URL if available
        if (img.stream && img.stream.h264 && img.stream.h264.length > 0) {
          const liveUrl = img.stream.h264[0].masterUrl;
          if (liveUrl) {
            liveUrls.push(liveUrl);
          }
        }
      }
    }

    // Extract video URL
    let videoUrl: string | undefined;
    if (noteData.type === 'video') {
      // Video URL would be in the video data - try to get it from page
      videoUrl = undefined; // Will need additional extraction
    }

    return { imageUrls, videoUrl, liveUrls };
  }

  /**
   * Format image URL to get direct link
   */
  private formatImageUrl(url: string): string {
    if (!url) return '';

    // Handle xhscdn.com URLs (including sns-webpic-qc.xhscdn.com)
    if (url.includes('xhscdn.com')) {
      // Extract the image path - handle URLs with query params or special chars
      // Example: http://sns-webpic-qc.xhscdn.com/202602242145/.../notes_pre_post/xxx!nd_dft_wlteh_webp_3
      const match = url.match(/(\/notes_pre_post\/[^!]+)/);
      if (match && match[1]) {
        return `https://sns-img-bd.xhscdn.com${match[1]}`;
      }

      // Fallback: try to extract token from URL
      const parts = url.split('/');
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].includes('notes_pre_post')) {
          const token = parts[i].split('!')[0];
          return `https://sns-img-bd.xhscdn.com/${token}`;
        }
      }
    }

    // Handle ci.xiaohongshu.com URLs
    if (url.includes('ci.xiaohongshu.com')) {
      return url;
    }

    // Return original if no transformation needed
    return url;
  }

  /**
   * Get image extension from URL
   */
  private getImageExtension(url: string): string {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('format/webp') || urlLower.includes('.webp')) {
      return 'webp';
    }
    if (urlLower.includes('format/png') || urlLower.includes('.png')) {
      return 'png';
    }
    if (urlLower.includes('format/heic') || urlLower.includes('.heic')) {
      return 'heic';
    }
    if (urlLower.includes('format/avif') || urlLower.includes('.avif')) {
      return 'avif';
    }
    return 'jpg';
  }

  /**
   * Download file from URL to local path
   */
  private async downloadFile(url: string, filepath: string): Promise<void> {
    try {
      // Using fetch API (available in Node.js 18+)
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.xiaohongshu.com/',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const fs = await import('fs');
      fs.writeFileSync(filepath, Buffer.from(buffer));
    } catch (error) {
      throw new Error(`Failed to download file: ${error}`);
    }
  }
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function sanitizeFileName(name: string): string {
  // Remove or replace characters that are invalid in file names
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}
