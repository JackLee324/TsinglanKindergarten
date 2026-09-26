import React from 'react';

/**
 * 404 page.
 * =========
 *
 * This rendered `NotFoundRender` from `@lark-apaas/client-toolkit`, which was:
 *
 *   <div class="min-h-screen flex flex-col items-center justify-center bg-white gap-3">
 *     <img src="https://lf3-static.bytednsdoc.com/…/illustration_empty_…_gray.svg" class="w-[100px]">
 *     <p class="text-l/[22px] text-[14px] text-[#1F2329] font-medium">页面不存在</p>
 *   </div>
 *
 * plus a `logger.log({…})` call carrying a "repair message" addressed to the 妙搭 AI
 * agent ("页面 {path} 不存在，帮我创建对应页面…"). That message existed only for the
 * platform's code generator and had no other consumer, so it is not reproduced.
 *
 * Every visual property is reproduced EXACTLY: the same wrapper classes, the same
 * `w-[100px]` image size, the same `text-l/[22px] text-[14px] text-[#1F2329]
 * font-medium` paragraph. The two things that could not stay byte-identical, and what
 * was done instead:
 *
 *   * the IMAGE is served from `/not-found.svg` (client/public) instead of a ByteDance
 *     CDN URL — a byte-identical copy of the same file, so the page looks the same
 *     while the runtime request to `lf3-static.bytednsdoc.com` disappears. See the
 *     comment at the top of that file.
 *   * the TEXT keeps the toolkit's own two strings and its language rule
 *     (`navigator.language.startsWith('zh') ? zh : en`, which is what the toolkit's
 *     `getLocale()` returned in a production build). The toolkit also honoured a
 *     `?locale=` query parameter and a localStorage key in DEVELOPMENT only; that was
 *     preview tooling, and the app's own language toggle governs the real pages.
 */

const MESSAGES = {
  zh: '页面不存在',
  en: 'Page not found',
} as const;

function browserLocale(): keyof typeof MESSAGES {
  const raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const NotFound: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white gap-3">
      <img src="/not-found.svg" alt="Not Found" className="w-[100px]" />
      <p className="text-l/[22px] text-[14px] text-[#1F2329] font-medium">
        {MESSAGES[browserLocale()]}
      </p>
    </div>
  );
};

export default NotFound;
