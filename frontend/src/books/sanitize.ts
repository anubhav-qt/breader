import DOMPurify from 'dompurify';

/**
 * Book HTML comes from files people upload, so it is always sanitised. Publisher styling is
 * set aside so every book gets Breader's typography.
 */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'link', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'font'],
    FORBID_ATTR: ['style', 'align', 'bgcolor', 'color', 'width', 'height'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob):|#|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
