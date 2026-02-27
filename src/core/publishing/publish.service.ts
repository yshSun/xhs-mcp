/**
 * Publishing service for XHS MCP Server
 */

import { Page, ElementHandle } from 'puppeteer';
import { Config, PublishResult } from '../../shared/types';
import { PublishError, InvalidImageError } from '../../shared/errors';
import { BaseService } from '../../shared/base.service';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../../shared/logger';
import { sleep } from '../../shared/utils';
import { ImageDownloader } from '../../shared/image-downloader';
import { assertTitleWidthValid, getTitleWidth } from '../../shared/title-validator';
import { COMMON_STATUS_SELECTORS, COMMON_TEXT_PATTERNS, COMMON_FILE_SELECTORS } from '../../shared/selectors';

// Constants for video publishing
const VIDEO_TIMEOUTS = {
  PAGE_LOAD: 3000,
  TAB_SWITCH: 2000,
  VIDEO_PROCESSING: 10000,
  CONTENT_WAIT: 1000,
  UPLOAD_READY: 1000,
  UPLOAD_START: 3000,
  PROCESSING_CHECK: 3000,
  COMPLETION_CHECK: 2000,
  PROCESSING_TIMEOUT: 120000, // 2 minutes
  COMPLETION_TIMEOUT: 300000, // 5 minutes
} as const;

const SELECTORS = {
  FILE_INPUT: COMMON_FILE_SELECTORS.FILE_INPUT,
  SUCCESS_INDICATORS: COMMON_STATUS_SELECTORS.SUCCESS,
  ERROR_INDICATORS: COMMON_STATUS_SELECTORS.ERROR,
  PROCESSING_INDICATORS: COMMON_STATUS_SELECTORS.PROCESSING,
  COMPLETION_INDICATORS: [
    '.upload-complete',
    '.processing-complete',
    '.video-ready',
    '[class*="complete"]',
    '[class*="ready"]',
  ],
  TOAST_SELECTORS: COMMON_STATUS_SELECTORS.TOAST,
  PUBLISH_PAGE_INDICATORS: [
    'div.upload-content',
    'div.submit',
    '.creator-editor',
    '.video-upload-container',
    'input[type="file"]',
  ],
} as const;

const TEXT_PATTERNS = COMMON_TEXT_PATTERNS;

export class PublishService extends BaseService {
  private imageDownloader: ImageDownloader;

  constructor(config: Config) {
    super(config);
    this.imageDownloader = new ImageDownloader('./temp_images');
  }

  // Helper methods for element detection and text matching
  private async findElementBySelectors(
    page: Page,
    selectors: readonly string[]
  ): Promise<any | null> {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element) {
        logger.debug(`Found element with selector: ${selector}`);
        return element;
      }
    }
    return null;
  }

  private async getElementText(element: Element): Promise<string | null> {
    try {
      return await (element as any).page().evaluate((el: Element) => el.textContent, element);
    } catch (error) {
      logger.warn(`Failed to get element text: ${error}`);
      return null;
    }
  }

  private async checkTextPatterns(
    text: string | null,
    patterns: readonly string[]
  ): Promise<boolean> {
    if (!text) return false;
    return patterns.some((pattern) => text.includes(pattern));
  }

  private async checkElementForPatterns(
    page: Page,
    selectors: readonly string[],
    patterns: readonly string[]
  ): Promise<{ found: boolean; text?: string; element?: any }> {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element) {
        const text = await this.getElementText(element as unknown as Element);
        if (text && (await this.checkTextPatterns(text, patterns))) {
          return { found: true, text, element };
        }
      }
    }
    return { found: false };
  }

  private async waitForCondition(
    condition: () => Promise<boolean>,
    timeout: number,
    checkInterval: number = 1000,
    errorMessage: string
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return;
      }
      await sleep(checkInterval);
    }

    throw new PublishError(errorMessage);
  }

  async publishNote(
    title: string,
    content: string,
    imagePaths: string[],
    tags: string = '',
    browserPath?: string
  ): Promise<PublishResult> {
    // Validate inputs
    if (!title?.trim()) {
      throw new PublishError('Note title cannot be empty');
    }

    // Validate title width (CJK characters count as 2 units, ASCII as 1)
    assertTitleWidthValid(title);
    logger.debug(`Title width validation passed: "${title}" (${getTitleWidth(title)} units)`);

    if (!content?.trim()) {
      throw new PublishError('Note content cannot be empty');
    }

    if (!imagePaths || imagePaths.length === 0) {
      throw new PublishError('At least one image is required');
    }

    // Process image paths - download URLs and validate local paths
    const resolvedPaths = await this.validateAndResolveImagePaths(imagePaths);

    // Wait for upload container selector
    const uploadSelector = 'div.upload-content';

    try {
      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        await this.getBrowserManager().navigateWithRetry(
          page,
          this.getConfig().xhs.creatorPublishUrl
        );

        // Wait for page to load
        await sleep(3000);

        // First, try to switch to the image/text upload tab
        await this.clickUploadTab(page);

        // Wait for tab switch to complete
        await sleep(3000);

        // Check if tab switch was successful and retry if needed
        const pageState = await page.evaluate(() => {
          return {
            buttonTexts: Array.from(document.querySelectorAll('button, div[role="button"]'))
              .map((el: Element) => el.textContent?.trim())
              .filter((t: string | undefined) => t),
          };
        });

        // If still showing video upload, try clicking the tab again
        if (
          pageState.buttonTexts.includes('上传视频') &&
          !pageState.buttonTexts.includes('上传图文')
        ) {
          await this.clickUploadTab(page);
          await sleep(3000);
        }

        let hasUploadContainer = await this.getBrowserManager().tryWaitForSelector(
          page,
          uploadSelector,
          30000
        );

        if (!hasUploadContainer) {
          // Try alternative selectors for upload container
          const alternativeSelectors = [
            'div.upload-content',
            '.upload-content',
            'div[class*="upload"]',
            'div[class*="image"]',
            'input[type="file"]',
          ];

          for (const selector of alternativeSelectors) {
            hasUploadContainer = await this.getBrowserManager().tryWaitForSelector(
              page,
              selector,
              10000
            );
            if (hasUploadContainer) {
              break;
            }
          }
        }

        if (!hasUploadContainer) {
          throw new PublishError('Could not find upload container on publish page');
        }

        // Upload images
        await this.uploadImages(page, resolvedPaths);

        // Wait for images to be processed
        await sleep(3000);

        // Wait for page to transition to edit mode (check for title or content input)
        try {
          await page.waitForSelector(
            'input[placeholder*="标题"], div[contenteditable="true"], .tiptap.ProseMirror',
            { timeout: 15000 }
          );
        } catch (error) {
          // Continue without waiting
        }

        // Wait a bit for the page to settle after image upload
        await sleep(2000);

        // Fill in title
        await this.fillTitle(page, title);

        // Wait a bit more for content area to appear
        await sleep(2000);

        // Fill in content
        await this.fillContent(page, content);

        // Add tags if provided
        if (tags) {
          await this.addTags(page, tags);
        }

        // Submit the note
        await this.submitPost(page);

        // Wait for completion and check result
        const noteId = await this.waitForPublishCompletion(page);

        // Save cookies
        await this.getBrowserManager().saveCookiesFromPage(page);

        return {
          success: true,
          message: 'Note published successfully',
          title,
          content,
          imageCount: resolvedPaths.length,
          tags,
          url: this.getConfig().xhs.creatorPublishUrl,
          noteId: noteId || undefined,
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Publish error: ${error}`);
      throw error;
    }
  }

  /**
   * Process image paths - download URLs and validate local paths
   */
  private async validateAndResolveImagePaths(imagePaths: string[]): Promise<string[]> {
    // Use ImageDownloader to process paths (downloads URLs, validates local paths)
    const resolvedPaths = await this.imageDownloader.processImagePaths(imagePaths);

    // Validate resolved paths
    for (const resolvedPath of resolvedPaths) {
      // For local paths that aren't absolute, resolve them
      const fullPath =
        resolvedPath.startsWith('/') || resolvedPath.match(/^[a-zA-Z]:/)
          ? resolvedPath
          : join(process.cwd(), resolvedPath);

      if (!existsSync(fullPath)) {
        throw new InvalidImageError(`Image file not found: ${resolvedPath}`);
      }

      const stats = statSync(fullPath);
      if (!stats.isFile()) {
        throw new InvalidImageError(`Path is not a file: ${resolvedPath}`);
      }

      // Check file extension
      const ext = resolvedPath.toLowerCase().split('.').pop();
      const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
      if (!ext || !allowedExtensions.includes(ext)) {
        throw new InvalidImageError(
          `Unsupported image format: ${resolvedPath}. Supported: ${allowedExtensions.join(', ')}`
        );
      }
    }

    if (resolvedPaths.length > 18) {
      throw new PublishError('Maximum 18 images allowed');
    }

    return resolvedPaths;
  }

  private async clickUploadTab(page: Page): Promise<void> {
    try {
      // Try multiple selectors for tabs
      const tabSelectors = [
        'div.creator-tab',
        '.creator-tab',
        '[role="tab"]',
        '.tab',
        'div[class*="tab"]',
      ];

      let tabs: any[] = [];
      for (const selector of tabSelectors) {
        const foundTabs = await page.$$(selector);
        if (foundTabs.length > 0) {
          tabs = foundTabs;
          break;
        }
      }

      if (tabs.length === 0) {
        // Try to find all clickable elements that might be tabs
        const allClickable = await page.$$('*');
        const possibleTabs: any[] = [];

        for (const element of allClickable.slice(0, 50)) {
          // Limit to first 50 elements
          try {
            const tagName = await page.evaluate((el) => el.tagName, element);
            const text = await page.evaluate((el) => el.textContent, element);
            const isVisible = await element.isIntersectingViewport();

            if (
              isVisible &&
              text &&
              (text.includes('上传视频') ||
                text.includes('上传图文') ||
                text.includes('写长文') ||
                text.includes('视频') ||
                text.includes('图文') ||
                text.includes('图片'))
            ) {
              possibleTabs.push({ element, text: text.trim() });
            }
          } catch (error) {
            // Ignore errors
          }
        }

        // Look for image/text upload tab
        for (const tab of possibleTabs) {
          if (
            tab.text.includes('上传图文') ||
            tab.text.includes('图文') ||
            tab.text.includes('图片')
          ) {
            await tab.element.click();
            await sleep(2000);
            return;
          }
        }

        return;
      }

      // Look for the "上传图文" (upload image/text) tab specifically
      let imageTextTab: any = null;
      const tabTexts: string[] = [];

      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        try {
          const isVisible = await tab.isIntersectingViewport();
          if (!isVisible) continue;

          const text = await page.evaluate((el) => el.textContent, tab);
          if (text) {
            tabTexts.push(text.trim());
          }

          // Check if this is the image/text upload tab
          if (
            text &&
            (text.includes('上传图文') || text.includes('图文') || text.includes('图片'))
          ) {
            imageTextTab = tab;
            break;
          }
        } catch (error) {
          // Ignore individual tab errors
        }
      }

      if (imageTextTab) {
        await imageTextTab.click();
        await sleep(2000); // Wait for tab switch
      } else {
        // Fallback: click the second tab (usually image/text upload)
        const visibleTabs: any[] = [];
        for (const tab of tabs) {
          const isVisible = await tab.isIntersectingViewport();
          if (isVisible) {
            visibleTabs.push(tab);
          }
        }

        if (visibleTabs.length > 1) {
          await visibleTabs[1].click(); // Usually the second tab is image/text
          await sleep(2000);
        } else if (visibleTabs.length > 0) {
          await visibleTabs[0].click();
          await sleep(2000);
        }
      }
    } catch (error) {
      logger.warn(`Failed to click upload tab: ${error}`);
    }
  }

  private async uploadImages(page: Page, imagePaths: string[]): Promise<void> {
    // Try primary file input selector - the input has 'multiple' attribute for multi-file upload
    let fileInput = await page.$('input[type=file].upload-input') as any;

    if (!fileInput) {
      // Fallback to alternative selector
      fileInput = await page.$('.upload-input') as any;

      if (!fileInput) {
        throw new PublishError('Could not find file upload input on page');
      }
    }

    console.log(`准备上传 ${imagePaths.length} 张图片:`, imagePaths);

    // Upload all images at once - we need to make sure we're using the right method
    // Depending on the Puppeteer version and element type, setInputFiles is the modern way
    try {
      // Check if setInputFiles method exists and use it
      if (fileInput && typeof fileInput.setInputFiles === 'function') {
        console.log('使用 setInputFiles 方法上传', imagePaths);
        await fileInput.setInputFiles(imagePaths);
      } else {
        // Fallback: use uploadFile method (older approach)
        // For multiple files, we need to call setInputFiles if available or handle appropriately
        // If the element doesn't support setInputFiles, try using the standard uploadFile
        console.log('setInputFiles 方法不可用，尝试一次性上传所有图片');

        // Try to upload all files using uploadFile method - newer versions support arrays
        try {
          await (fileInput as any).uploadFile(...imagePaths);
        } catch (uploadError) {
          console.log('批量上传失败，尝试逐个上传但确保图片处理完整');
          // Upload each image file, but ensure all are processed properly
          for (const imagePath of imagePaths) {
            await fileInput.uploadFile(imagePath);
            // Add a short delay between uploads to allow for UI updates
            await sleep(1000);
          }
        }
      }

      // Wait for images to be processed - wait longer to ensure all images appear in UI
      console.log('等待图片完全处理完成...');
      await sleep(15000); // Increased wait time to ensure all images are fully processed

      // Verify that all images were uploaded by waiting for the expected number of image elements
      await page.waitForFunction(
        (expectedCount) => {
          // Look for various elements that represent uploaded images
          const imageElements = document.querySelectorAll('img[src^="blob:"], .image-item, .uploaded-image, .preview-image, .cover-item, .image-container');
          console.log('已找到图像元素数量:', imageElements.length, '预期数量:', expectedCount);
          return imageElements.length >= expectedCount;
        },
        { timeout: 60000 }, // Increased timeout to allow for proper image processing
        imagePaths.length
      );

      // Additional verification - check that the uploaded images are displayed
      for (let i = 0; i < imagePaths.length; i++) {
        try {
          await page.waitForSelector('img[src^="blob:"], .image-item, .uploaded-image, .preview-image, .cover-item', { timeout: 10000 });
        } catch (waitError) {
          console.warn(`Warning: Could not confirm all image uploads after waiting`);
        }
      }

      // Final verification - wait a bit more to ensure everything is settled
      console.log('最终等待图片处理完成...');
      await sleep(5000);
    } catch (error) {
      throw new PublishError(`Failed to upload images: ${error}`);
    }
  }

  private async fillTitle(page: Page, title: string): Promise<void> {
    const titleSelectors = [
      'input[placeholder*="标题"]',
      'input[placeholder*="title"]',
      'input[data-placeholder*="标题"]',
      '.title-input input',
      'input[type="text"]',
      'input[placeholder*="请输入标题"]',
      'input[placeholder*="标题"]',
      'input[name="title"]',
      'input[id*="title"]',
      'input[class*="title"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="标题"]',
      'textarea[placeholder*="title"]',
    ];

    for (const selector of titleSelectors) {
      try {
        const titleInput = await page.$(selector);
        if (titleInput) {
          const isVisible = await titleInput.isIntersectingViewport();

          if (isVisible) {
            await titleInput.click();
            await sleep(500); // Wait for focus
            await titleInput.type(title);
            return;
          }
        }
      } catch (error) {
        // Continue to next selector
      }
    }

    // If no input found, try to find any input or textarea on the page
    try {
      const allInputs = await page.$$('input, textarea, [contenteditable="true"]');

      for (let i = 0; i < allInputs.length; i++) {
        const input = allInputs[i];
        try {
          const isVisible = await input.isIntersectingViewport();
          const tagName = await page.evaluate((el) => el.tagName, input);

          if (isVisible && (tagName === 'INPUT' || tagName === 'TEXTAREA')) {
            await input.click();
            await sleep(500);
            await input.type(title);
            return;
          }
        } catch (error) {
          // Continue to next input
        }
      }
    } catch (error) {
      // Fall through to error
    }

    throw new PublishError('Could not find title input field');
  }

  private async findContentElement(page: Page): Promise<any | null> {
    try {
      // Strategy 1: Try div[contenteditable="true"] (simple and direct)
      const contentEditable = await page.$('div[contenteditable="true"]');
      if (contentEditable) {
        const isVisible = await contentEditable.isIntersectingViewport();
        if (isVisible) {
          return contentEditable;
        }
      }

      // Strategy 1.5: Try div with aria-label containing content description
      const ariaLabelContent = await page.$('div[aria-label*="正文"], div[aria-label*="内容"], div[aria-label*="description"]');
      if (ariaLabelContent) {
        const isVisible = await ariaLabelContent.isIntersectingViewport();
        if (isVisible) {
          return ariaLabelContent;
        }
      }

      // Strategy 1.75: Try with data attributes that indicate content input
      const dataAttributeContent = await page.$('div[data-placeholder*="正文"], div[data-placeholder*="内容"], div[data-placeholder*="description"]');
      if (dataAttributeContent) {
        const isVisible = await dataAttributeContent.isIntersectingViewport();
        if (isVisible) {
          return dataAttributeContent;
        }
      }

      // Strategy 2: Try div.tiptap.ProseMirror (primary selector for creator platform)
      const tiptapEditor = await page.$('div.tiptap.ProseMirror');
      if (tiptapEditor) {
        const isVisible = await tiptapEditor.isIntersectingViewport();
        if (isVisible) {
          return tiptapEditor;
        }
      }

      // Strategy 2.5: Try new editor classes that might be used
      const newEditorClass = await page.$('.editor-container, .note-editor, .xhs-editor, .creator-editor, .text-editor, .content-input');
      if (newEditorClass) {
        const isVisible = await newEditorClass.isIntersectingViewport();
        if (isVisible) {
          return newEditorClass;
        }
      }

      // Strategy 3: Try div[role="textbox"][contenteditable="true"] (specific selector)
      const roleTextbox = await page.$('div[role="textbox"][contenteditable="true"]');
      if (roleTextbox) {
        const isVisible = await roleTextbox.isIntersectingViewport();
        if (isVisible) {
          return roleTextbox;
        }
      }

      // Strategy 4: Try div.ql-editor (legacy selector)
      const qlEditor = await page.$('div.ql-editor');
      if (qlEditor) {
        return qlEditor;
      }

      // Strategy 5: Try to find textarea or contenteditable
      const contentSelectors = [
        '.tiptap.ProseMirror',
        'textarea[placeholder*="正文"]',
        'textarea[placeholder*="内容"]',
        'textarea[placeholder*="desc"]',
        'textarea[multiline]',
        'div[data-placeholder*="正文"]',
        'div[data-placeholder*="内容"]',
        'div[data-placeholder*="description"]',
        '.content-editor',
        'div[role="textbox"]',
        'textbox[role="textbox"]',
        'textbox[multiline]',
        'div[placeholder*="输入"]',
        'div[aria-placeholder*="正文"]',
        'div[aria-placeholder*="内容"]',
        'div[aria-placeholder*="description"]',
        '.ProseMirror',
        '.editor-input',
        '[class*="content"]',
        '[class*="editor"]',
        '[class*="text"]'
      ];

      for (const selector of contentSelectors) {
        const element = await page.$(selector);
        if (element) {
          return element;
        }
      }

      // Strategy 6: Try to find any multiline textbox (fallback)
      const multilineTextboxes = await page.$$('textbox[multiline]');
      for (const element of multilineTextboxes) {
        const isVisible = await element.isIntersectingViewport();
        if (isVisible) {
          return element;
        }
      }

      // Strategy 7: Check for specific XiaoHongShu content areas
      const xhsSpecificSelectors = [
        '.note-textarea',
        '.input-container',
        '.editor-wrapper',
        '.content-input-area',
        '[data-v-*][class*="editor"]', // Vue-specific selectors
        '[class*="RichText"]',
        '[class*="rich-text"]',
        '[class*="description"]',
        '[class*="textarea"]'
      ];

      for (const selector of xhsSpecificSelectors) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isIntersectingViewport();
          if (isVisible) {
            return element;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async findTextboxByPlaceholder(page: Page): Promise<any | null> {
    try {
      // Find all p elements
      const pElements = await page.$$('p');

      // Look for element with data-placeholder containing "输入正文描述"
      for (const p of pElements) {
        const placeholder = await page.evaluate((el) => el.getAttribute('data-placeholder'), p);
        if (placeholder?.includes('输入正文描述')) {
          return p;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async findTextboxParent(page: Page, element: Element): Promise<any> {
    try {
      return await page.evaluateHandle((el) => el.parentElement, element);
    } catch (error) {
      return null;
    }
  }

  private async fillContent(page: Page, content: string): Promise<void> {
    // Wait for content area to appear
    try {
      await page.waitForSelector(
        'div[role="textbox"][contenteditable="true"], .tiptap.ProseMirror, div[contenteditable="true"], textarea, [role="textbox"], .ql-editor, textbox[multiline], div[aria-label*="正文"], .editor-container, .note-editor, .xhs-editor, .creator-editor, div[placeholder*="输入"], div[aria-placeholder*="正文"], .ProseMirror, .editor-input, [class*="content"], [class*="editor"], [class*="text"]',
        { timeout: 10000 }
      );
    } catch (error) {
      // Continue without waiting
    }

    let contentElement = await this.findContentElement(page);

    if (!contentElement) {
      // Try alternative approach
      const textboxElement = await this.findTextboxByPlaceholder(page);
      if (textboxElement) {
        contentElement = await this.findTextboxParent(page, textboxElement);
      }
    }

    if (!contentElement) {
      // Try to find any contenteditable or textarea element
      try {
        const allContentElements = await page.$$(
          'div[role="textbox"][contenteditable="true"], .tiptap.ProseMirror, div[contenteditable="true"], textarea, [role="textbox"], .ql-editor, p[contenteditable="true"], textbox[multiline], div[aria-label*="正文"], .editor-container, .note-editor, .xhs-editor, .creator-editor, div[placeholder*="输入"], div[aria-placeholder*="正文"], .ProseMirror, .editor-input, [class*="content"], [class*="editor"], [class*="text"]'
        );

        for (let i = 0; i < allContentElements.length; i++) {
          const element = allContentElements[i];
          try {
            const isVisible = await element.isIntersectingViewport();
            const tagName = await page.evaluate((el) => el.tagName, element);
            const contentEditable = await page.evaluate(
              (el) => el.getAttribute('contenteditable'),
              element
            );
            const role = await page.evaluate((el) => el.getAttribute('role'), element);
            const className = await page.evaluate((el) => el.className, element);
            const multiline = await page.evaluate((el) => el.getAttribute('multiline'), element);

            if (
              isVisible &&
              (contentEditable === 'true' ||
                tagName === 'TEXTAREA' ||
                role === 'textbox' ||
                className.includes('ql-editor') ||
                className.includes('tiptap') ||
                multiline === '')
            ) {
              contentElement = element;
              break;
            }
          } catch (error) {
            // Continue to next element
          }
        }
      } catch (error) {
        // Continue to next strategy
      }
    }

    if (!contentElement) {
      // Last resort: try to find any element that might be for content
      try {
        const allElements = await page.$$('*');

        for (let i = 0; i < Math.min(allElements.length, 50); i++) {
          // Limit to first 50 elements
          const element = allElements[i];
          try {
            const isVisible = await element.isIntersectingViewport();
            const tagName = await page.evaluate((el) => el.tagName, element);
            const contentEditable = await page.evaluate(
              (el) => el.getAttribute('contenteditable'),
              element
            );
            const className = await page.evaluate((el) => el.className, element);
            const placeholder = await page.evaluate(
              (el) => el.getAttribute('placeholder'),
              element
            );

            if (
              isVisible &&
              (contentEditable === 'true' ||
                tagName === 'TEXTAREA' ||
                className.includes('content') ||
                className.includes('editor') ||
                placeholder?.includes('内容') ||
                placeholder?.includes('正文'))
            ) {
              contentElement = element;
              break;
            }
          } catch (error) {
            // Ignore errors for individual elements
          }
        }
      } catch (error) {
        // Fall through to error
      }
    }

    if (!contentElement) {
      throw new PublishError('Could not find content input field');
    }

    try {
      // Check if the element is an element node and clickable
      const elementIsClickable = await page.evaluate(element => {
        // Check if element exists and is an element node
        if (!element || !(element instanceof Element)) {
          return false;
        }

        // Check if element is visible and not disabled
        const computedStyle = window.getComputedStyle(element);
        const isVisible = computedStyle.display !== 'none' &&
                         computedStyle.visibility !== 'hidden' &&
                         computedStyle.opacity !== '0';
        const isEnabled = computedStyle.pointerEvents !== 'none';

        return isVisible && isEnabled;
      }, contentElement);

      if (!elementIsClickable) {
        throw new PublishError('Content element is not clickable or visible');
      }

      // Click the element first to focus it
      await contentElement.click();
      await sleep(500); // Wait for focus

      // Try to type into the element
      await contentElement.type(content);
    } catch (error) {
      logger.warn(`Standard typing failed: ${error}. Trying alternative method...`);

      try {
        // Alternative: Use page.evaluate to set the content directly
        await page.evaluate((element, content) => {
          if (element) {
            // Clear existing content
            element.textContent = '';

            // Set the new content
            if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
              element.value = content;
            } else {
              element.textContent = content;

              // Trigger input event to notify any listeners
              const event = new Event('input', { bubbles: true });
              element.dispatchEvent(event);
            }
          }
        }, contentElement, content);
      } catch (evalError) {
        logger.error(`Alternative content filling method failed: ${evalError}`);
        throw new PublishError(`Failed to fill content: ${evalError}`);
      }
    }
  }

  private async inputTags(contentElement: Element, tags: string): Promise<void> {
    const tagList = tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    for (const tag of tagList) {
      await this.inputTag(contentElement, tag);
    }
  }

  private async inputTag(contentElement: Element, tag: string): Promise<void> {
    try {
      // Get the page from the content element's context
      const page = await (contentElement as any).page();
      
      // Try to find topic suggestion container
      const topicContainer = await page.$('#creator-editor-topic-container');

      if (topicContainer) {
        const firstItem = await topicContainer.$('.item');
        if (firstItem) {
          await firstItem.click();
          await sleep(500);
        }
      }

      // Type the tag
      await (contentElement as any).type(`#${tag}`);
      await sleep(500);

      // Press Enter to confirm the tag
      await (contentElement as any).press('Enter');
      await sleep(500);
    } catch (error) {
      logger.warn(`Failed to add tag ${tag}: ${error}`);
    }
  }

  private async addTags(page: Page, tags: string): Promise<void> {
    try {
      const contentElement = await this.findContentElement(page);
      if (contentElement) {
        await this.inputTags(contentElement, tags);
      }
    } catch (error) {
      logger.warn(`Failed to add tags: ${error}`);
    }
  }

  private async submitPost(page: Page): Promise<void> {
    logger.debug('Attempting to find and click the publish button...');

    // Wait for the page to be fully loaded and the publish button to be available
    await sleep(2000);

    // Wait specifically for the publish button container to appear
    try {
      await page.waitForSelector('.publish-page-publish-btn', { timeout: 20000 });
      logger.debug('Publish button container appeared');
    } catch (error) {
      logger.warn('Publish button container not found after waiting');
    }

    // Wait for video upload to complete before attempting to click the publish button
    // The button might be grayed out during upload
    logger.debug('Waiting for video upload to complete...');
    await this.waitForVideoUploadCompletion(page);

    // Find the button based on the HTML structure provided by the user
    // There are two buttons in the container: "暂存离开" and "发布"
    // We want the "发布" button, which is the one that is NOT "暂存离开"
    let publishButton = null;

    // Look specifically in the publish container for the "发布" button that has bg-red class
    try {
      const publishContainer = await page.$('.publish-page-publish-btn');
      if (publishContainer) {
        const allButtons = await page.$$('.publish-page-publish-btn button');
        logger.debug(`Found ${allButtons.length} buttons in publish container`);

        for (const button of allButtons) {
          const text = await page.evaluate(el => el.textContent?.trim() || '', button);
          const classes = await page.evaluate(el => el.className || '', button);

          logger.debug(`Button: "${text}", Classes: "${classes}"`);

          // Find the button that has "发布" text AND bg-red class (the actual publish button)
          if (text.includes('发布') && classes.includes('bg-red')) {
            publishButton = button;
            logger.debug(`Found the "发布" button with bg-red class: "${text}"`);
            break;
          }
        }
      }
    } catch (error) {
      logger.warn(`Error looking in publish container: ${error}`);
    }

    // If still not found, try to find any button with "发布" text that doesn't contain unwanted text
    if (!publishButton) {
      try {
        const allButtons = await page.$$('button');
        for (const button of allButtons) {
          const text = await page.evaluate(el => el.textContent?.trim() || '', button);

          // Look for the button with "发布" text but exclude buttons with unwanted text
          if (text.includes('发布') &&
              !text.includes('暂存') &&
              !text.includes('草稿') &&
              !text.includes('保存') &&
              !text.includes('离开')) {
            publishButton = button;
            logger.debug(`Found "发布" button globally: "${text}"`);
            break;
          }
        }
      } catch (error) {
        logger.warn(`Error looking for button globally: ${error}`);
      }
    }

    if (!publishButton) {
      // Log available buttons for debugging
      const containerButtonsInfo = await page.evaluate(() => {
        const container = document.querySelector('.publish-page-publish-btn');
        if (container) {
          const buttons = container.querySelectorAll('button');
          return Array.from(buttons).map(btn => ({
            text: btn.textContent?.trim() || '',
            className: btn.className || '',
            id: btn.id || ''
          }));
        }
        return [];
      });

      const allButtonsInfo = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.map(btn => ({
          text: btn.textContent?.trim() || '',
          className: btn.className || '',
          id: btn.id || ''
        })).slice(0, 10); // Just get first 10 for debugging
      });

      logger.error(`Could not find the "发布" button. Container buttons: ${JSON.stringify(containerButtonsInfo, null, 2)}`);
      logger.error(`All page buttons (first 10): ${JSON.stringify(allButtonsInfo, null, 2)}`);
      throw new PublishError('Could not find the "发布" button');
    }

    try {
      const buttonText = await page.evaluate(el => el.textContent?.trim() || '', publishButton);
      logger.debug(`About to click publish button: "${buttonText}"`);

      // Scroll into view first
      await page.evaluate(el => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, publishButton);

      await sleep(500);

      // Click the button
      await publishButton.click();

      logger.debug(`Successfully clicked publish button: "${buttonText}"`);
      await sleep(5000); // Wait for processing
    } catch (error) {
      logger.error(`Failed to click publish button: ${error}`);
      throw new PublishError(`Failed to click publish button: ${error}`);
    }
  }

  private async isElementVisible(element: Element): Promise<boolean> {
    try {
      return await (element as any).isIntersectingViewport();
    } catch (error) {
      return false;
    }
  }

  private async waitForPublishCompletion(page: Page): Promise<string | null> {
    const maxWaitTime = 60000; // 60 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check for success indicators
      const successIndicators = [
        '.success-message',
        '.publish-success',
        '[data-testid="publish-success"]',
        '.toast-success',
      ];

      for (const selector of successIndicators) {
        const element = await page.$(selector);
        if (element) {
          await sleep(2000); // Wait a bit more for any final processing
          return await this.extractNoteIdFromPage(page);
        }
      }

      // Check for error indicators
      const errorIndicators = [
        '.error-message',
        '.publish-error',
        '[data-testid="publish-error"]',
        '.toast-error',
        '.error-toast',
      ];

      for (const selector of errorIndicators) {
        const element = await page.$(selector);
        if (element) {
          const errorText = await page.evaluate((el) => el.textContent, element);
          throw new PublishError(`Publish failed with error: ${errorText}`);
        }
      }

      // Check if we're still on the publish page
      const publishPageIndicators = ['div.upload-content', 'div.submit', '.creator-editor'];

      let stillOnPublishPage = false;
      for (const selector of publishPageIndicators) {
        const element = await page.$(selector);
        if (element) {
          stillOnPublishPage = true;
          break;
        }
      }

      if (!stillOnPublishPage) {
        // We've left the publish page, likely successful
        logger.debug('Left publish page, assuming success');
        return await this.extractNoteIdFromPage(page);
      }

      // Check for toast messages
      const toastSelectors = ['.toast', '.message', '.notification', '[role="alert"]'];

      for (const selector of toastSelectors) {
        const element = await page.$(selector);
        if (element) {
          const toastText = await page.evaluate((el) => el.textContent, element);
          if (toastText) {
            if (toastText.includes('成功') || toastText.includes('success')) {
              logger.debug(`Found success toast: ${toastText}`);
              return await this.extractNoteIdFromPage(page);
            } else if (
              toastText.includes('失败') ||
              toastText.includes('error') ||
              toastText.includes('错误')
            ) {
              throw new PublishError(`Publish failed: ${toastText}`);
            }
          }
        }
      }

      await sleep(1000); // Wait before next check
    }

    throw new PublishError('Publish completion timeout - could not determine result');
  }

  private async waitForVideoUploadCompletion(page: Page): Promise<void> {
    logger.debug('Checking for video upload completion...');

    const startTime = Date.now();
    const timeout = 300000; // 5 minutes timeout

    // Wait for signs that video upload is processing/completed
    while (Date.now() - startTime < timeout) {
      try {
        // Check if there are any processing indicators
        let processingElements: ElementHandle[] = [];

        const processingSelectors = ['.uploading', '.upload-progress', '[class*="progress"]', '[class*="loading"]'];
        for (const selector of processingSelectors) {
          const elements = await page.$$(selector);
          processingElements = processingElements.concat(elements);
        }

        if (processingElements.length === 0) {
          // No processing indicators found, might be complete
          logger.debug('No upload processing indicators found, checking for completion');

          // Check for publish button to see if it's enabled (not grayed out)
          const publishButtons = await page.$$('.publish-page-publish-btn button');

          if (publishButtons.length > 0) {
            for (const button of publishButtons) {
              const text = await page.evaluate(el => el.textContent?.trim() || '', button);
              const classes = await page.evaluate(el => el.className || '', button);

              // Check if it's the publish button and it's not disabled
              if (text.includes('发布')) {
                // Check if the button is not disabled or grayed out
                const isDisabled = await page.evaluate(el => el.disabled || el.hasAttribute('disabled'), button);

                // Check if button has "gray" or "disabled" class indicating it's not clickable yet
                if (!isDisabled && !classes.includes('disabled') && !classes.toLowerCase().includes('gray')) {
                  logger.debug(`Publish button "${text}" is available and enabled`);
                  return; // Upload is complete and button is clickable
                }
              }
            }
          }
        } else {
          logger.debug(`Still processing (${processingElements.length} indicators found), waiting...`);
        }

        // Check for success indicators that video upload completed
        const successIndicators = [
          '.upload-complete',
          '.video-ready',
          '[class*="complete"]',
          '[class*="ready"]',
          '[class*="success"]'
        ];

        for (const selector of successIndicators) {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await page.evaluate(el => {
              const style = window.getComputedStyle(el);
              return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }, element);

            if (isVisible) {
              logger.debug(`Found upload completion indicator: ${selector}`);
              return;
            }
          }
        }

        // Wait before checking again
        await sleep(2000);
      } catch (error) {
        logger.warn(`Error during video upload check: ${error}`);
        await sleep(1000);
        continue;
      }
    }

    logger.warn('Video upload completion check timed out, proceeding anyway...');
  }

  private async extractNoteIdFromPage(page: Page): Promise<string | null> {
    try {
      // Method 1: Try to extract from URL if redirected to note page
      const currentUrl = page.url();
      logger.debug(`Current URL after publish: ${currentUrl}`);
      
      // Check if we're on a note page (URL contains /explore/ or /discovery/)
      const noteIdMatch = currentUrl.match(/\/explore\/([a-f0-9]+)/i) || 
                         currentUrl.match(/\/discovery\/([a-f0-9]+)/i);
      
      if (noteIdMatch && noteIdMatch[1]) {
        const noteId = noteIdMatch[1];
        logger.debug(`Extracted note ID from URL: ${noteId}`);
        return noteId;
      }

      // Method 2: Try to find note ID in page content or data attributes
      const noteIdFromPage = await page.evaluate(() => {
        // Look for data attributes that might contain note ID
        const elementsWithData = document.querySelectorAll('[data-note-id], [data-id], [data-impression]');
        for (let i = 0; i < elementsWithData.length; i++) {
          const element = elementsWithData[i];
          const noteId = element.getAttribute('data-note-id') || 
                        element.getAttribute('data-id') || 
                        element.getAttribute('data-impression');
          if (noteId && noteId.length > 10) { // Note IDs are typically long
            return noteId;
          }
        }

        // Look for links to note pages
        const noteLinks = document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/"]');
        for (let i = 0; i < noteLinks.length; i++) {
          const link = noteLinks[i];
          const href = link.getAttribute('href');
          if (href) {
            const match = href.match(/\/explore\/([a-f0-9]+)/i) || 
                         href.match(/\/discovery\/([a-f0-9]+)/i);
            if (match && match[1]) {
              return match[1];
            }
          }
        }

        // Look for any text that looks like a note ID (long hex string)
        const textContent = document.body.textContent || '';
        const noteIdPattern = /[a-f0-9]{20,}/gi;
        const matches = textContent.match(noteIdPattern);
        if (matches && matches.length > 0) {
          // Return the first long hex string found
          return matches[0];
        }

        return null;
      });

      if (noteIdFromPage) {
        logger.debug(`Extracted note ID from page content: ${noteIdFromPage}`);
        return noteIdFromPage;
      }

      // Method 3: Try to get the latest note ID using NoteService (fallback)
      logger.debug('Could not extract note ID from page, trying fallback method');
      try {
        // Wait a bit for the note to be processed
        await sleep(5000);
        
        // Use NoteService to get the latest note ID
        const { NoteService } = await import('../notes/note.service');
        const noteService = new NoteService(this.getConfig());
        const userNotes = await noteService.getUserNotes(1); // Get only the latest note
        
        if (userNotes.success && userNotes.data && userNotes.data.length > 0) {
          const latestNoteId = userNotes.data[0].id;
          logger.debug(`Extracted note ID from NoteService: ${latestNoteId}`);
          return latestNoteId;
        }
      } catch (error) {
        logger.warn(`Fallback note ID extraction failed: ${error}`);
      }

      logger.debug('Could not extract note ID from any method');
      return null;
    } catch (error) {
      logger.warn(`Failed to extract note ID: ${error}`);
      return null;
    }
  }

  private async waitForVideoPublishCompletion(page: Page): Promise<string | null> {
    logger.debug('Waiting for video publish completion...');

    let isProcessing = false;

    await this.waitForCondition(
      async () => {
        // Check for success indicators
        const successResult = await this.checkElementForPatterns(
          page,
          SELECTORS.SUCCESS_INDICATORS,
          TEXT_PATTERNS.SUCCESS
        );

        if (successResult.found) {
          logger.debug(`Found success indicator: ${successResult.text}`);
          await sleep(VIDEO_TIMEOUTS.COMPLETION_CHECK);
          return true;
        }

        // Check for error indicators
        const errorResult = await this.checkElementForPatterns(
          page,
          SELECTORS.ERROR_INDICATORS,
          TEXT_PATTERNS.ERROR
        );

        if (errorResult.found) {
          throw new PublishError(`Video publish failed with error: ${errorResult.text}`);
        }

        // Check if we've left the publish page (likely success)
        const stillOnPage = await this.findElementBySelectors(
          page,
          SELECTORS.PUBLISH_PAGE_INDICATORS
        );
        if (!stillOnPage) {
          logger.debug('Left publish page, assuming video publish success');
          return true;
        }

        // Check for processing status
        const processingResult = await this.checkElementForPatterns(
          page,
          SELECTORS.PROCESSING_INDICATORS,
          TEXT_PATTERNS.PROCESSING
        );

        isProcessing = processingResult.found;
        if (isProcessing) {
          logger.debug(`Video still processing: ${processingResult.text}`);
        }

        // Check for toast messages
        const toastResult = await this.checkElementForPatterns(
          page,
          SELECTORS.TOAST_SELECTORS,
          TEXT_PATTERNS.SUCCESS
        );

        if (toastResult.found) {
          logger.debug(`Found success toast: ${toastResult.text}`);
          return true;
        }

        const errorToastResult = await this.checkElementForPatterns(
          page,
          SELECTORS.TOAST_SELECTORS,
          TEXT_PATTERNS.ERROR
        );

        if (errorToastResult.found) {
          throw new PublishError(`Video publish failed: ${errorToastResult.text}`);
        }

        return false;
      },
      VIDEO_TIMEOUTS.COMPLETION_TIMEOUT,
      isProcessing ? 5000 : VIDEO_TIMEOUTS.COMPLETION_CHECK,
      'Video publish completion timeout - could not determine result after 5 minutes'
    );

    // Extract note ID after successful completion
    return await this.extractNoteIdFromPage(page);
  }

  // Unified publish method for both images and videos
  async publishContent(
    type: 'image' | 'video',
    title: string,
    content: string,
    mediaPaths: string[],
    tags: string = '',
    browserPath?: string
  ): Promise<PublishResult> {
    // Validate inputs
    this.validateContentInputs(type, title, content, mediaPaths);

    if (type === 'image') {
      return await this.publishNote(title, content, mediaPaths, tags, browserPath);
    } else {
      // For videos, only take the first path
      const videoPath = mediaPaths[0];
      return await this.publishVideo(title, content, videoPath, tags, browserPath);
    }
  }

  async publishVideo(
    title: string,
    content: string,
    videoPath: string,
    tags: string = '',
    browserPath?: string
  ): Promise<PublishResult> {
    // Validate inputs
    this.validateVideoInputs(title, content, videoPath);

    // Validate and resolve video path
    const resolvedVideoPath = this.validateAndResolveVideoPath(videoPath);

    try {
      const page = await this.getBrowserManager().createPage(false, browserPath, true);

      try {
        const noteId = await this.executeVideoPublishWorkflow(page, title, content, resolvedVideoPath, tags);

        // Save cookies
        await this.getBrowserManager().saveCookiesFromPage(page);

        return {
          success: true,
          message: 'Video published successfully',
          title,
          content,
          imageCount: 0, // Videos don't have image count
          tags,
          url: this.getConfig().xhs.creatorVideoPublishUrl,
          noteId: noteId || undefined,
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error(`Video publish error: ${error}`);
      throw error;
    }
  }

  private validateContentInputs(
    type: 'image' | 'video',
    title: string,
    content: string,
    mediaPaths: string[]
  ): void {
    if (!title?.trim()) {
      throw new PublishError(`${type === 'image' ? 'Image' : 'Video'} title cannot be empty`);
    }

    if (!content?.trim()) {
      throw new PublishError(`${type === 'image' ? 'Image' : 'Video'} content cannot be empty`);
    }

    if (!mediaPaths || mediaPaths.length === 0) {
      throw new PublishError(`${type === 'image' ? 'Image' : 'Video'} paths are required`);
    }

    if (type === 'image' && mediaPaths.length > 18) {
      throw new PublishError('Maximum 18 images allowed for image posts');
    }

    if (type === 'video' && mediaPaths.length !== 1) {
      throw new PublishError('Video publishing requires exactly one video file');
    }
  }

  private validateVideoInputs(title: string, content: string, videoPath: string): void {
    if (!title?.trim()) {
      throw new PublishError('Video title cannot be empty');
    }

    // Validate title width for video posts too
    assertTitleWidthValid(title);
    logger.debug(`Video title width validation passed: "${title}" (${getTitleWidth(title)} units)`);

    if (!content?.trim()) {
      throw new PublishError('Video content cannot be empty');
    }

    if (!videoPath?.trim()) {
      throw new PublishError('Video path is required');
    }
  }

  private async executeVideoPublishWorkflow(
    page: Page,
    title: string,
    content: string,
    videoPath: string,
    tags: string
  ): Promise<string | null> {
    // Navigate to video upload page
    await this.getBrowserManager().navigateWithRetry(
      page,
      this.getConfig().xhs.creatorVideoPublishUrl
    );

    // Wait for page to load
    await sleep(VIDEO_TIMEOUTS.PAGE_LOAD);

    // Wait for the video upload UI to appear
    await page.waitForSelector('.publish-page-publish-btn, .upload-video-container, #upload-container, [class*="upload"]', { timeout: 15000 });

    // Switch to video upload tab if needed
    await this.clickVideoUploadTab(page);

    // Wait for tab switch to complete
    await sleep(VIDEO_TIMEOUTS.TAB_SWITCH);

    // Upload video
    await this.uploadVideo(page, videoPath);

    // Wait for video to be processed (videos take longer than images)
    await sleep(VIDEO_TIMEOUTS.VIDEO_PROCESSING);

    // Wait specifically for the publish button to appear
    try {
      await page.waitForSelector('.publish-page-publish-btn', { timeout: 15000 });
      logger.debug('Publish button container appeared');
    } catch (error) {
      logger.warn('Publish button container not found, continuing anyway');
    }

    // Fill in title
    await this.fillTitle(page, title);

    // Wait a bit for content area to appear
    await sleep(VIDEO_TIMEOUTS.CONTENT_WAIT);

    // Fill in content
    await this.fillContent(page, content);

    // Add tags if provided
    if (tags) {
      await this.addTags(page, tags);
    }

    // Wait a moment for UI to settle before clicking publish
    await sleep(2000);

    // Submit the video - this is where we ensure we're clicking the right button
    await this.submitPost(page);

    // Wait for completion and check result (videos need longer timeout)
    return await this.waitForVideoPublishCompletion(page);
  }

  private validateAndResolveVideoPath(videoPath: string): string {
    const resolvedPath = join(process.cwd(), videoPath);

    if (!existsSync(resolvedPath)) {
      throw new PublishError(`Video file not found: ${videoPath}`);
    }

    const stats = statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new PublishError(`Path is not a file: ${videoPath}`);
    }

    // Check file extension
    const ext = videoPath.toLowerCase().split('.').pop();
    const allowedExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'];
    if (!ext || !allowedExtensions.includes(ext)) {
      throw new PublishError(
        `Unsupported video format: ${videoPath}. Supported: ${allowedExtensions.join(', ')}`
      );
    }

    // Check file size (XHS typically has limits)
    const maxSizeInMB = 500; // 500MB limit
    const fileSizeInMB = stats.size / (1024 * 1024);
    if (fileSizeInMB > maxSizeInMB) {
      throw new PublishError(
        `Video file too large: ${fileSizeInMB.toFixed(2)}MB. Maximum allowed: ${maxSizeInMB}MB`
      );
    }

    return resolvedPath;
  }

  private async clickVideoUploadTab(page: Page): Promise<void> {
    try {
      // Try multiple selectors for video tab
      const videoTabSelectors = [
        'div.creator-tab',
        '.creator-tab',
        '[role="tab"]',
        '.tab',
        'div[class*="tab"]',
      ];

      let tabs: any[] = [];
      for (const selector of videoTabSelectors) {
        const foundTabs = await page.$$(selector);
        if (foundTabs.length > 0) {
          tabs = foundTabs;
          break;
        }
      }

      if (tabs.length === 0) {
        logger.warn('No tabs found for video upload');
        return;
      }

      // Look for the video upload tab specifically
      let videoTab: any = null;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        try {
          const isVisible = await tab.isIntersectingViewport();
          if (!isVisible) continue;

          const text = await page.evaluate((el) => el.textContent, tab);

          // Check if this is the video upload tab
          if (
            text &&
            (text.includes('上传视频') || text.includes('视频') || text.includes('video'))
          ) {
            videoTab = tab;
            break;
          }
        } catch (error) {
          // Ignore individual tab errors
        }
      }

      if (videoTab) {
        await videoTab.click();
        await sleep(2000); // Wait for tab switch
      } else {
        // Fallback: click the first tab (usually video upload)
        const visibleTabs: any[] = [];
        for (const tab of tabs) {
          const isVisible = await tab.isIntersectingViewport();
          if (isVisible) {
            visibleTabs.push(tab);
          }
        }

        if (visibleTabs.length > 0) {
          await visibleTabs[0].click(); // Usually the first tab is video upload
          await sleep(2000);
        }
      }
    } catch (error) {
      logger.warn(`Failed to click video upload tab: ${error}`);
    }
  }

  private async uploadVideo(page: Page, videoPath: string): Promise<void> {
    logger.debug(`Uploading video: ${videoPath}`);

    // Find file input element
    const fileInput = await this.findElementBySelectors(page, SELECTORS.FILE_INPUT);
    if (!fileInput) {
      throw new PublishError('Could not find file upload input on video upload page');
    }

    try {
      // Wait for the input to be ready
      await sleep(VIDEO_TIMEOUTS.UPLOAD_READY);

      // Upload the video file
      await fileInput.uploadFile(videoPath);
      logger.debug('Video file uploaded, waiting for processing...');

      // Wait for upload to start and show progress
      await sleep(VIDEO_TIMEOUTS.UPLOAD_START);

      // Wait for video processing to complete (this can take a while)
      await this.waitForVideoProcessing(page);
    } catch (error) {
      throw new PublishError(`Failed to upload video ${videoPath}: ${error}`);
    }
  }

  private async waitForVideoProcessing(page: Page): Promise<void> {
    logger.debug('Waiting for video processing to complete...');

    try {
      await this.waitForCondition(
        async () => {
          // Check if processing is complete
          const completeResult = await this.checkElementForPatterns(
            page,
            SELECTORS.COMPLETION_INDICATORS,
            TEXT_PATTERNS.SUCCESS
          );

          if (completeResult.found) {
            logger.debug(`Video processing complete: ${completeResult.text}`);
            return true;
          }

          // Check if still processing
          const processingResult = await this.checkElementForPatterns(
            page,
            SELECTORS.PROCESSING_INDICATORS,
            TEXT_PATTERNS.PROCESSING
          );

          if (processingResult.found) {
            logger.debug(`Video processing: ${processingResult.text}`);
            return false; // Still processing, continue waiting
          }

          // If not processing and no completion indicator, assume it's done
          logger.debug('No processing indicators found, assuming video processing complete');
          return true;
        },
        VIDEO_TIMEOUTS.PROCESSING_TIMEOUT,
        VIDEO_TIMEOUTS.PROCESSING_CHECK,
        'Video processing timeout'
      );
    } catch (error) {
      logger.warn('Video processing timeout, continuing anyway...');
    }
  }
}
