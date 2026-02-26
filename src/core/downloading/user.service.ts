/**
 * User service for XHS MCP Server
 * Provides functionality to fetch user profile and their notes
 */

import { Page } from 'puppeteer';
import { Config } from '../../shared/types';
import { DownloadError } from '../../shared/errors';
import { BaseService } from '../../shared/base.service';
import { logger } from '../../shared/logger';
import { sleep } from '../../shared/utils';

// User profile interface
interface UserProfile {
  userId: string;
  nickname: string;
  xhsNumber?: string; // 小红书号
  avatar?: string;
  desc?: string;
  followers?: number;
  following?: number;
  likes?: number;
}

// Note item from user profile
interface NoteItem {
  noteId: string;
  title: string;
  type: 'video' | 'normal';
  cover?: string;
  time: number;
  interactInfo?: {
    likedCount: string;
    collectedCount: string;
    commentCount: string;
  };
}

export class UserService extends BaseService {
  constructor(config: Config) {
    super(config);
  }

  /**
   * Get user profile and their notes from profile URL or xhs number
   * @param input - Either a profile URL (https://www.xiaohongshu.com/user/profile/...),
   *                 short link (xhslink.com/...), or xhs number (小红书号)
   * @param limit - Maximum number of notes to retrieve (default 10)
   * @param browserPath - Optional custom browser path
   */
  async getUserProfile(
    input: string,
    limit: number = 10,
    browserPath?: string
  ): Promise<{
    success: boolean;
    profile?: UserProfile;
    notes: Array<{
      noteId: string;
      title: string;
      type: string;
      url: string;
      time: number;
    }>;
    message?: string;
  }> {
    try {
      // Resolve input to profile URL
      const profileUrl = await this.resolveProfileUrl(input, browserPath);
      if (!profileUrl) {
        throw new DownloadError(`Invalid user input: ${input}`);
      }

      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        // Navigate to user profile
        logger.debug(`Navigating to user profile: ${profileUrl}`);
        await this.getBrowserManager().navigateWithRetry(page, profileUrl);
        await sleep(5000); // Wait longer for initial content to load

        // Scroll down and wait for notes to load
        for (let i = 0; i < 3; i++) {  // Perform multiple scrolls to trigger lazy loading
          await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight * 0.8);
          });
          await sleep(3000); // Wait for content to load after scroll

          // Check if notes are loading by looking for loading indicators or checking initial state
          const isLoading = await page.evaluate(() => {
            const win = window as any; // Cast to any to access __INITIAL_STATE__
            const state = win.__INITIAL_STATE__;

            if (state && state.user) {
              // Check if notes are still being fetched
              if (state.user.isFetchingNotes && typeof state.user.isFetchingNotes._value !== 'undefined') {
                return state.user.isFetchingNotes._value;
              }
              if (state.user.userNoteFetchingStatus && typeof state.user.userNoteFetchingStatus._value !== 'undefined') {
                return state.user.userNoteFetchingStatus._value !== 'success';
              }

              // Check if user has loaded
              if (state.user.userInfo && typeof state.user.userInfo._value !== 'undefined') {
                return !state.user.userInfo._value;
              }
            }
            return false;
          });

          if (!isLoading) {
            logger.debug('Notes appear to be loaded, breaking scroll loop');
            break;
          }

          logger.debug(`Still loading notes, continuing scroll iteration ${i + 1}/3`);
        }

        // Extract user data
        const userData = await this.extractUserData(page);

        if (!userData) {
          throw new DownloadError('Failed to extract user data from profile page');
        }

        // Get notes
        const notes = await this.getUserNotes(page, limit);

        return {
          success: true,
          profile: userData.profile,
          notes: notes.map((note) => ({
            noteId: note.noteId,
            title: note.title || 'Untitled',
            type: note.type === 'video' ? 'video' : 'image',
            url: `https://www.xiaohongshu.com/explore/${note.noteId}`,
            time: note.time,
          })),
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Get user profile error: ${error}`);
      throw new DownloadError(`Failed to get user profile: ${error}`);
    }
  }

  /**
   * Resolve input to profile URL
   * Supports:
   * - Full profile URL: https://www.xiaohongshu.com/user/profile/xxx
   * - Short link: https://xhslink.com/m/xxx or xhslink.com/xxx
   * - XHS number (小红书号): Will search for the user
   */
  private async resolveProfileUrl(input: string, browserPath?: string): Promise<string | null> {
    // Check if it's already a profile URL
    if (input.includes('xiaohongshu.com/user/profile')) {
      return input.startsWith('http') ? input : `https://${input}`;
    }

    // Check if it's a short link (xhslink.com)
    if (input.includes('xhslink.com')) {
      const url = input.startsWith('http') ? input : `https://${input}`;
      try {
        const page = await this.getBrowserManager().createPage(false, browserPath, false);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(3000);
          let finalUrl = page.url();

          // If it's a webcast URL, try to convert to profile page
          // Short links like xhslink.com/m/xxx are often profile pages
          if (finalUrl.includes('webcast') || finalUrl.includes('live')) {
            // Try to get user info from the page and construct profile URL
            const userId = await page.evaluate(() => {
              // Try to find userId from page data
              const win = window as any;
              const state = win.__INITIAL_STATE__;
              if (state?.user?.userInfo?.userId) return state.user.userInfo.userId;
              if (state?.user?.otherUserInfo?.userId) return state.user.otherUserInfo.userId;
              return null;
            });

            if (userId) {
              finalUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;
            }
          }

          logger.debug(`Short link resolved: ${input} -> ${finalUrl}`);
          return finalUrl;
        } finally {
          await page.close();
        }
      } catch (error) {
        logger.warn(`Failed to resolve short link: ${error}`);
        return null;
      }
    }

    // Check if it looks like an XHS number (纯数字或字母数字组合)
    // 小红书号通常是数字，但也可能包含字母
    const isXhsNumber = /^[\w-]+$/.test(input) && !input.includes('/') && !input.includes('.');

    if (isXhsNumber) {
      // Try to access profile page directly first
      const directUrl = `https://www.xiaohongshu.com/user/profile/${input}`;
      logger.debug(`Trying direct profile URL for XHS number: ${directUrl}`);

      try {
        const page = await this.getBrowserManager().createPage(false, browserPath, true);
        try {
          await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(2000);

          // Check if the page loaded successfully (not a 404 or error page)
          const pageContent = await page.evaluate(() => {
            // Check for error indicators
            const errorText = document.body.innerText;
            if (errorText.includes('页面不存在') || errorText.includes('找不到')) {
              return null;
            }
            // Check if we have user data
            const win = window as any;
            if (win.__INITIAL_STATE__ && win.__INITIAL_STATE__.user) {
              return window.location.href;
            }
            return window.location.href;
          });

          if (pageContent) {
            logger.debug(`Direct profile URL worked: ${directUrl}`);
            return directUrl;
          }
        } finally {
          await page.close();
        }
      } catch (error) {
        logger.debug(`Direct profile URL failed, will try search: ${error}`);
      }

      // If direct access failed, try searching for the user
      logger.debug(`Searching for XHS number: ${input}`);
      const searchResult = await this.searchUserByXhsNumber(input, browserPath);
      if (searchResult) {
        return searchResult;
      }
    }

    // Fallback: assume it's a user ID
    return `https://www.xiaohongshu.com/user/profile/${input}`;
  }

  /**
   * Search for user by XHS number (小红书号)
   * Uses the search functionality to find the user's profile
   */
  private async searchUserByXhsNumber(xhsNumber: string, browserPath?: string): Promise<string | null> {
    try {
      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        // Navigate to search page with the XHS number
        const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(xhsNumber)}&source=web_explore_feed`;
        logger.debug(`Searching for user at: ${searchUrl}`);

        await this.getBrowserManager().navigateWithRetry(page, searchUrl);
        await sleep(3000);

        // Try to find user profile link from search results
        const profileUrl = await page.evaluate(`
          (() => {
            const win = window;
            // Try to get user info from search results
            if (win.__INITIAL_STATE__ && win.__INITIAL_STATE__.search) {
              const searchState = win.__INITIAL_STATE__.search;

              // Check for user results
              if (searchState.userResult && searchState.userResult.result) {
                const users = searchState.userResult.result;
                if (users && users.length > 0) {
                  const user = users[0];
                  if (user.userId || user.id) {
                    return '/user/profile/' + (user.userId || user.id);
                  }
                }
              }

              // Check for notes that might contain user info
              if (searchState.feeds && searchState.feeds._value) {
                const feeds = searchState.feeds._value;
                if (feeds && feeds.length > 0) {
                  // Look for a note from the user we're searching for
                  for (const feed of feeds) {
                    if (feed.user && (feed.user.redId === xhsNumber || feed.user.userId)) {
                      return '/user/profile/' + feed.user.userId;
                    }
                  }
                  // Fallback: get the first note's user
                  if (feeds[0] && feeds[0].user && feeds[0].user.userId) {
                    return '/user/profile/' + feeds[0].user.userId;
                  }
                }
              }
            }

            // Try to find user link in DOM
            const userLinks = document.querySelectorAll('a[href*="/user/profile/"]');
            if (userLinks.length > 0) {
              const href = userLinks[0].getAttribute('href');
              if (href) {
                return href;
              }
            }

            return null;
          })()
        `);

        if (profileUrl && typeof profileUrl === 'string') {
          const fullUrl = profileUrl.startsWith('http')
            ? profileUrl
            : `https://www.xiaohongshu.com${profileUrl}`;
          logger.debug(`Found profile URL from search: ${fullUrl}`);
          return fullUrl;
        }

        logger.warn(`Could not find user profile for XHS number: ${xhsNumber}`);
        return null;
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Failed to search for user by XHS number: ${error}`);
      return null;
    }
  }

  /**
   * Extract user data from profile page
   */
  private async extractUserData(page: Page): Promise<{
    profile: UserProfile;
  } | null> {
    try {
      // Debug: print all keys in __INITIAL_STATE__
      const debugInfo = await page.evaluate(() => {
        const win = window as any;
        const initialState = win.__INITIAL_STATE__;
        const result: any = { hasInitialState: !!initialState, keys: [], url: window.location.href };

        if (initialState) {
          result.keys = Object.keys(initialState);

          // Try to find user data
          if (initialState.user) {
            result.userKeys = Object.keys(initialState.user);
          }
        }

        // Also check for any JSON scripts
        const scripts = document.querySelectorAll('script[type="application/json"]');
        result.scriptCount = scripts.length;

        // Check page title
        result.pageTitle = document.title;

        return result;
      });
      logger.debug(`User data debug: ${JSON.stringify(debugInfo)}`);

      const userData = await page.evaluate(() => {
        const win = window as any;
        const initialState = win.__INITIAL_STATE__;

        if (!initialState) return null;

        // Helper function to safely get value from Vue reactive objects
        const getReactiveValue = (obj: any) => {
          try {
            if (obj && typeof obj === 'object') {
              // Check if it's a Vue reactive object with _value
              if ('_value' in obj && obj._value !== undefined) {
                return obj._value;
              }
              // Or check if it's a regular object/array
              return obj;
            }
            return obj;
          } catch (e) {
            // If there's an error accessing the object, return it as-is
            return obj;
          }
        };

        // Try different paths for user data
        let userInfo = null;

        try {
          // Path 1: initialState.user.userInfo (which is likely a reactive object)
          if (initialState.user) {
            // Don't unwrap the whole user object, access properties individually
            if (initialState.user.userInfo) {
              userInfo = getReactiveValue(initialState.user.userInfo);
            } else if (initialState.user.otherUserInfo) {
              userInfo = getReactiveValue(initialState.user.otherUserInfo);
            } else if (initialState.user.userInfoMap && typeof initialState.user.userInfoMap === 'object') {
              const keys = Object.keys(initialState.user.userInfoMap);
              if (keys.length > 0) {
                userInfo = getReactiveValue(initialState.user.userInfoMap[keys[0]]);
              }
            } else if (initialState.user.currentUser) {
              userInfo = getReactiveValue(initialState.user.currentUser);
            } else if (initialState.user.profile) {
              userInfo = getReactiveValue(initialState.user.profile);
            } else if (initialState.user.userPageData && initialState.user.userPageData.userInfo) {
              userInfo = getReactiveValue(initialState.user.userPageData.userInfo);
            }
          }

          // Path 2: initialState.userInfo
          if (!userInfo && initialState.userInfo) {
            userInfo = getReactiveValue(initialState.userInfo);
          }

          // Path 3: initialState.userProfile
          if (!userInfo && initialState.userProfile) {
            userInfo = getReactiveValue(initialState.userProfile);
          }

          // Path 4: Check for user page data
          if (!userInfo && initialState.userPage) {
            if (initialState.userPage.userInfo) {
              userInfo = getReactiveValue(initialState.userPage.userInfo);
            }
          }
        } catch (ex: any) {
          // If we fail to extract from initial state, we'll fall back to DOM extraction
          console.warn('Error extracting user data from initial state:', ex.message);
        }

        // Path 5: Try to extract from DOM as fallback
        if (!userInfo) {
          const nicknameEl = document.querySelector('.user-name, .nickname, [class*="nickname"], [class*="userName"]');
          const avatarEl = document.querySelector('.avatar img, [class*="avatar"] img');
          const descEl = document.querySelector('.user-desc, .desc, [class*="desc"]');

          if (nicknameEl || avatarEl) {
            userInfo = {
              nickname: nicknameEl?.textContent?.trim() || '',
              avatar: (avatarEl as HTMLImageElement)?.src || '',
              desc: descEl?.textContent?.trim() || '',
            };
          }
        }

        if (!userInfo) return null;

        return {
          profile: {
            userId: userInfo.userId || userInfo.id || '',
            nickname: userInfo.nickname || userInfo.name || userInfo.nickName || userInfo.userName || '',
            xhsNumber: userInfo.redId || userInfo.xhsNumber || userInfo.id || '',
            avatar: userInfo.avatar || userInfo.image || '',
            desc: userInfo.desc || userInfo.description || '',
          }
        };
      });

      return userData as { profile: UserProfile } | null;
    } catch (error) {
      logger.error(`Failed to extract user data: ${error}`);
      return null;
    }
  }

  /**
   * Get user notes from profile page with scrolling support
   */
  private async getUserNotes(page: Page, limit: number): Promise<NoteItem[]> {
    try {
      const notes = await page.evaluate(async (noteLimit: number) => {
        const win = window as any;
        const notesList: any[] = [];

        // Helper function to extract notes from initial state
        const extractFromInitialState = () => {
          const initialState = win.__INITIAL_STATE__;
          if (!initialState) return;

          if (initialState.user) {
            const user = initialState.user;

            // Helper function to safely get value from Vue reactive objects
            const getReactiveValue = (obj: any) => {
              if (obj && typeof obj === 'object') {
                // Check if it's a Vue reactive object with _value
                if ('_value' in obj && obj._value !== undefined) {
                  return obj._value;
                }
                // Or check if it's a regular object/array
                return obj;
              }
              return obj;
            };

            // Extract from user.notes (may be a reactive object)
            const notesData = getReactiveValue(user.notes);
            if (notesData && Array.isArray(notesData)) {
              for (const note of notesData) {
                notesList.push({
                  noteId: note.noteId || note.id || '',
                  title: note.title || note.displayTitle || '',
                  type: note.type || 'normal',
                  time: note.time || note.publishTime || 0,
                });
              }
            }

            // Extract from user.noteQueries (pagination data)
            if (user.noteQueries && typeof user.noteQueries === 'object') {
              const noteQueryKeys = Object.keys(user.noteQueries);
              for (const queryKey of noteQueryKeys) {
                const query = user.noteQueries[queryKey];
                if (query && typeof query === 'object') {
                  const queryData = getReactiveValue(query);
                  if (queryData.data && Array.isArray(queryData.data.notes)) {
                    for (const note of queryData.data.notes) {
                      notesList.push({
                        noteId: note.noteId || note.id || '',
                        title: note.title || note.displayTitle || '',
                        type: note.type || 'normal',
                        time: note.time || note.publishTime || 0,
                      });
                    }
                  } else if (queryData.data && Array.isArray(queryData.data.list)) {
                    for (const note of queryData.data.list) {
                      notesList.push({
                        noteId: note.noteId || note.id || '',
                        title: note.title || note.displayTitle || '',
                        type: note.type || 'normal',
                        time: note.time || note.publishTime || 0,
                      });
                    }
                  }
                }
              }
            }

            // Extract from user.userInfoMap
            if (user.userInfoMap) {
              const keys = Object.keys(user.userInfoMap);
              if (keys.length > 0) {
                const userInfo = getReactiveValue(user.userInfoMap[keys[0]]);
                if (userInfo && userInfo.posts) {
                  const posts = Array.isArray(userInfo.posts) ? userInfo.posts : getReactiveValue(userInfo.posts);
                  if (Array.isArray(posts)) {
                    for (const post of posts) {
                      notesList.push({
                        noteId: post.noteId || post.id || '',
                        title: post.title || '',
                        type: post.type || 'normal',
                        time: post.time || post.publishTime || 0,
                      });
                    }
                  }
                }
                if (userInfo && userInfo.notes) {
                  const userNotes = Array.isArray(userInfo.notes) ? userInfo.notes : getReactiveValue(userInfo.notes);
                  if (Array.isArray(userNotes)) {
                    for (const note of userNotes) {
                      notesList.push({
                        noteId: note.noteId || note.id || '',
                        title: note.title || note.displayTitle || '',
                        type: note.type || 'normal',
                        time: note.time || note.publishTime || 0,
                      });
                    }
                  }
                }
              }
            }

            // Extract from user.postList (may be a reactive object)
            const postListData = getReactiveValue(user.postList);
            if (postListData && Array.isArray(postListData)) {
              for (const note of postListData) {
                notesList.push({
                  noteId: note.noteId || note.id || '',
                  title: note.title || '',
                  type: note.type || 'normal',
                  cover: note.cover || note.image || '',
                  time: note.time || note.publishTime || 0,
                });
              }
            }

            // Extract from user.userPageData
            if (user.userPageData) {
              const pageData = getReactiveValue(user.userPageData);
              if (pageData && pageData.notes) {
                const pageNotes = Array.isArray(pageData.notes) ? pageData.notes : getReactiveValue(pageData.notes);
                if (Array.isArray(pageNotes)) {
                  for (const note of pageNotes) {
                    notesList.push({
                      noteId: note.noteId || note.id || '',
                      title: note.title || note.displayTitle || '',
                      type: note.type || 'normal',
                      time: note.time || note.publishTime || 0,
                    });
                  }
                }
              }
            }
          }
        };

        // Helper function to extract notes from DOM
        const extractFromDOM = () => {
          // More specific selectors for note elements
          const selectors = [
            'a[href*="/explore/"]',
            '[class*="note-item"] a[href*="/explore/"]',
            '[class*="note-card"] a[href*="/explore/"]',
            '[class*="note"] a[href*="/explore/"]',
            '[data-note-id]',
            '[data-impression*="noteId"]',
            'div[onclick*="noteId"] a[href*="/explore/"]'
          ];

          // Combine all matching elements
          const allCards = new Set();
          selectors.forEach(selector => {
            try {
              const elements = document.querySelectorAll(selector);
              elements.forEach(el => allCards.add(el));
            } catch (e) {
              // Skip invalid selectors
            }
          });

          const cards = Array.from(allCards);
          for (const card of cards) {
            try {
              const link = (card as Element).tagName === 'A' ? card : (card as Element).querySelector('a[href*="/explore/"]');
              if (link) {
                const href = (link as Element).getAttribute('href');
                if (href) {
                  const match = href.match(/\/explore\/([a-zA-Z0-9]+)/);
                  if (match && match[1]) {
                    const existingNote = notesList.find(n => n.noteId === match[1]);
                    if (!existingNote) {
                      // Look for title in the closest context
                      let title = '';
                      const titleSelectors = ['[class*="title"]', '[class*="content"]', '[class*="desc"]'];
                      for (const sel of titleSelectors) {
                        const titleEl = (card as Element).matches(sel) ? card : (card as Element).querySelector(sel);
                        if (titleEl) {
                          const textContent = (titleEl as HTMLElement).textContent;
                          if (textContent) {
                            title = textContent.trim().slice(0, 100);
                            break;
                          }
                        }
                      }

                      // If no title found in specific elements, use text content of the link or parent
                      if (!title) {
                        const linkText = (link as HTMLElement).textContent;
                        const cardText = (card as HTMLElement).textContent;
                        title = linkText?.trim().slice(0, 100) || cardText?.trim().slice(0, 100) || 'Untitled';
                      }

                      notesList.push({
                        noteId: match[1],
                        title: title || 'Untitled',
                        type: 'normal',
                        time: 0,
                      });
                    }
                  }
                }
              }

              // Alternative: check for data-note-id attribute directly on the element
              const dataNoteId = (card as Element).getAttribute('data-note-id');
              if (dataNoteId && !notesList.some(n => n.noteId === dataNoteId)) {
                let title = '';
                const titleSelectors = ['[class*="title"]', '[class*="content"]', '[class*="desc"]'];
                for (const sel of titleSelectors) {
                  const titleEl = (card as Element).matches(sel) ? card : (card as Element).querySelector(sel);
                  if (titleEl) {
                    const textContent = (titleEl as HTMLElement).textContent;
                    if (textContent) {
                      title = textContent.trim().slice(0, 100);
                      break;
                    }
                  }
                }

                notesList.push({
                  noteId: dataNoteId,
                  title: title || 'Untitled',
                  type: 'normal',
                  time: 0,
                });
              }
            } catch (e) {
              // Continue to next element
            }
          }
        };

        // Helper function to scroll and wait for more content
        const scrollForMore = async (): Promise<boolean> => {
          const scrollHeight = document.documentElement.scrollHeight;
          const scrollTop = window.scrollY;
          const clientHeight = window.innerHeight;

          if (scrollTop + clientHeight >= scrollHeight - 100) {
            return false; // Already at bottom
          }

          window.scrollBy(0, clientHeight);
          await new Promise(resolve => setTimeout(resolve, 1500));

          // Check if new content loaded
          const newScrollHeight = document.documentElement.scrollHeight;
          return newScrollHeight > scrollHeight;
        };

        // Initial extraction
        extractFromInitialState();
        extractFromDOM();

        // Scroll to load more notes (up to limit)
        let scrollAttempts = 0;
        const maxScrollAttempts = 10;

        while (notesList.length < noteLimit && scrollAttempts < maxScrollAttempts) {
          const hasMore = await scrollForMore();
          if (!hasMore) {
            // Try extracting again in case new content loaded
            extractFromInitialState();
            extractFromDOM();
            break;
          }
          scrollAttempts++;

          // Re-extract after scroll
          extractFromInitialState();
          extractFromDOM();
        }

        return notesList.slice(0, noteLimit);
      }, limit);

      return notes as NoteItem[];
    } catch (error) {
      logger.error(`Failed to get user notes: ${error}`);
      return [];
    }
  }

  /**
   * Get only the note links from user profile (optimized for link extraction)
   * @param input - Either a profile URL (https://www.xiaohongshu.com/user/profile/...),
   *                 short link (xhslink.com/...), or xhs number (小红书号)
   * @param limit - Maximum number of note links to retrieve (default 20)
   * @param browserPath - Optional custom browser path
   */
  async getUserNoteLinks(
    input: string,
    limit: number = 20,
    browserPath?: string
  ): Promise<{
    success: boolean;
    profile?: UserProfile;
    noteLinks: Array<{
      noteId: string;
      title: string;
      url: string;
      fullUrl: string;
    }>;
    message?: string;
  }> {
    try {
      // Resolve input to profile URL
      const profileUrl = await this.resolveProfileUrl(input, browserPath);
      if (!profileUrl) {
        throw new DownloadError(`Invalid user input: ${input}`);
      }

      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        // Navigate to user profile
        logger.debug(`Navigating to user profile: ${profileUrl}`);
        await this.getBrowserManager().navigateWithRetry(page, profileUrl);
        await sleep(5000); // Wait longer for initial content to load

        // Scroll down to load more notes
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight * 0.8);
          });
          await sleep(3000); // Wait for content to load after scroll
        }

        // Extract user data
        const userData = await this.extractUserData(page);

        // Extract note links from DOM (optimized for link extraction)
        const noteLinks = await page.evaluate(async (linkLimit: number) => {
          // First, get all notes from the initial page state
          const win = window as any;
          const initialState = win.__INITIAL_STATE__;

          const notesFromState = [];
          if (initialState && initialState.user) {
            // Check if noteQueries contain xsecToken data
            if (initialState.user.noteQueries) {
              const noteQueries = initialState.user.noteQueries;
              for (const key in noteQueries) {
                const query = noteQueries[key];
                if (query && query.data && query.data.notes) {
                  for (const note of query.data.notes) {
                    notesFromState.push({
                      noteId: note.noteId || note.id,
                      xsecToken: note.xsecToken || note.xsec_token || null
                    });
                  }
                }
              }
            }

            // Also check user.userPageData for additional note information
            if (initialState.user.userPageData && initialState.user.userPageData.notes) {
              for (const note of initialState.user.userPageData.notes) {
                notesFromState.push({
                  noteId: note.noteId || note.id,
                  xsecToken: note.xsecToken || note.xsec_token || null
                });
              }
            }
          }

          // Find all potential note elements, prioritizing those with xsec_token
          const allNoteElements = Array.from(document.querySelectorAll(
            'a[href*="/user/profile/"][href*="xsec_token"], ' +
            'a[href*="/explore/"], ' +
            'a[href*="/user/profile/"], ' +
            'div[data-note-id], ' +
            '[data-impression*="noteId"], ' +
            '[class*="note-item"], ' +
            '[class*="note-card"], ' +
            '[class*="cover"]'
          ));

          const linksList = [];
          const processedNoteIds = new Set();

          // Process elements in priority order: first the ones with xsec_token
          const elementsWithTokens = allNoteElements.filter(el => {
            const href = (el as Element).getAttribute('href');
            return href && href.includes('xsec_token');
          });

          const elementsWithoutTokens = allNoteElements.filter(el => {
            const href = (el as Element).getAttribute('href');
            return !href || !href.includes('xsec_token');
          });

          // Process first elements that contain xsec_token
          for (const el of [...elementsWithTokens, ...elementsWithoutTokens]) {
            if (linksList.length >= linkLimit) break;

            // Get the full href with parameters
            let href = (el as Element).getAttribute('href');

            // If element is not an anchor, look for child anchors
            if (!href && (el as Element).querySelector) {
              const childLink = (el as Element).querySelector('a[href*="/explore/"], a[href*="/user/profile/"]');
              if (childLink) {
                href = (childLink as Element).getAttribute('href');
              }
            }

            let dataNoteId = (el as Element).getAttribute('data-note-id');
            let dataImpression = (el as Element).getAttribute('data-impression');

            let noteId = '';
            let xsecToken = '';

            // Try to extract from href first - this can be either /explore/ or /user/profile/ format
            if (href) {
              // Match /explore/{noteId} format
              const exploreMatch = href.match(/\/explore\/([a-zA-Z0-9]+)/);
              if (exploreMatch) {
                noteId = exploreMatch[1];
              } else {
                // Match /user/profile/{userId}/{noteId}?xsec_token=... format
                const profileMatch = href.match(/\/user\/profile\/[a-zA-Z0-9]+\/([a-zA-Z0-9]+)/);
                if (profileMatch) {
                  noteId = profileMatch[1];

                  // Extract xsec_token from the URL parameters
                  const urlParams = new URLSearchParams(href.split('?')[1] || '');
                  xsecToken = urlParams.get('xsec_token') || '';
                }
              }
            }

            // If we didn't get noteId from href, try other methods
            if (!noteId && !xsecToken) { // Only try backup methods if we didn't get from href
              if (!noteId && dataNoteId) {
                noteId = dataNoteId;
              }

              if (!noteId && dataImpression) {
                try {
                  const parsed = JSON.parse(dataImpression);
                  if (parsed?.noteTarget?.value?.noteId) {
                    noteId = parsed.noteTarget.value.noteId;
                  }
                  if (parsed?.noteTarget?.value?.xsecToken) {
                    xsecToken = parsed.noteTarget.value.xsecToken;
                  }
                } catch(e) {
                  // ignore
                }
              }
            }

            if (noteId && !processedNoteIds.has(noteId)) {
              processedNoteIds.add(noteId);

              // Look for title in the element or nearby elements
              let title = '';

              // Look for titles in specific elements - especially footer
              const titleSelectors = ['[class*="footer"]', '.footer', '[class*="title"]', '[class*="content"]', '[class*="desc"]'];
              for (const sel of titleSelectors) {
                const titleEl = (el as Element).querySelector ? (el as Element).querySelector(sel) : null;
                if (titleEl && (titleEl as HTMLElement).textContent?.trim()) {
                  // Clean up title to exclude common footer items like timestamps
                  let rawTitle = (titleEl as HTMLElement).textContent.trim();

                  // Remove timestamp patterns from titles
                  rawTitle = rawTitle.replace(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|\d+天前|\d+小时前|\d+分钟前/g, '').trim();
                  rawTitle = rawTitle.replace(/^\s*-\s*|\s*-\s*$/g, '').trim(); // Remove dashes around text

                  if (rawTitle && rawTitle.length > 0 && rawTitle.length < 150) {
                    title = rawTitle;
                    break;
                  }
                }
              }

              // If no title found in specific elements, look for any text content
              if (!title) {
                // Look for titles in parent or nearby siblings
                const parentElement = el.parentElement;
                const siblingTitle = parentElement?.querySelector('[class*="title"], [class*="content"], [class*="desc"], [class*="footer"]');
                if (siblingTitle && (siblingTitle as HTMLElement).textContent?.trim()) {
                  let rawTitle = (siblingTitle as HTMLElement).textContent.trim();
                  rawTitle = rawTitle.replace(/\d{4}-\d{2}-\d{2}|\d+天前|\d+小时前/g, '').trim();
                  rawTitle = rawTitle.replace(/^\s*-\s*|\s*-\s*$/g, '').trim();

                  if (rawTitle && rawTitle.length > 0 && rawTitle.length < 150) {
                    title = rawTitle;
                  }
                }
              }

              // If we still don't have a title, look in the main element's text
              if (!title && (el as HTMLElement).textContent?.trim() && !(el as HTMLElement).textContent.includes(noteId)) {
                let rawTitle = (el as HTMLElement).textContent.trim().substring(0, 150);
                rawTitle = rawTitle.replace(/\d{4}-\d{2}-\d{2}|\d+天前|\d+小时前/g, '').trim();
                rawTitle = rawTitle.replace(/^\s*-\s*|\s*-\s*$/g, '').trim();

                if (rawTitle && rawTitle.length > 0) {
                  title = rawTitle;
                }
              }

              // Build the full URL with parameters if they exist
              let fullUrl = '';

              // If we have a complete URL with protocol and parameters
              if (href && href.startsWith('http')) {
                // Make sure it's the xiaohongshu URL and potentially includes xsec_token
                fullUrl = href;
              }
              // If we have a relative URL with parameters
              else if (href && href.startsWith('/')) {
                // If href already contains the user profile format with xsec_token, convert to explore format
                if (href.includes('/user/profile/') && href.includes('xsec_token=')) {
                  const noteIdMatch = href.match(/\/user\/profile\/[a-zA-Z0-9]+\/([a-zA-Z0-9]+)/);
                  const urlParams = new URLSearchParams(href.split('?')[1] || '');
                  const token = urlParams.get('xsec_token');

                  if (noteIdMatch && token) {
                    fullUrl = `https://www.xiaohongshu.com/explore/${noteIdMatch[1]}?xsec_token=${token}`;
                  } else {
                    fullUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
                  }
                }
                // If the relative URL already contains the noteId, use it as is
                else if (href.includes(noteId)) {
                  fullUrl = `https://www.xiaohongshu.com${href}`;
                } else {
                  fullUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
                }
              }
              // Fallback to basic URL
              else {
                fullUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
              }

              // If we still don't have an xsec_token but found one from initial state
              if (!fullUrl.includes('xsec_token') && xsecToken) {
                const separator = fullUrl.includes('?') ? '&' : '?';
                fullUrl = `${fullUrl}${separator}xsec_token=${xsecToken}`;
              }

              linksList.push({
                noteId: noteId,
                title: title || 'Untitled',
                url: `https://www.xiaohongshu.com/explore/${noteId}`,
                fullUrl: fullUrl
              });
            }
          }

          // Remove duplicates based on note ID
          const uniqueLinks = [];
          const seenIds = new Set();
          for (const link of linksList) {
            if (!seenIds.has(link.noteId)) {
              seenIds.add(link.noteId);
              uniqueLinks.push(link);
            }
          }

          return uniqueLinks.slice(0, linkLimit);
        }, limit);

        return {
          success: true,
          profile: userData?.profile,
          noteLinks: noteLinks,
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Get user note links error: ${error}`);
      throw new DownloadError(`Failed to get user note links: ${error}`);
    }
  }
}
