// A read-only DOM inventory for setup. Never return input values, account text,
// cookies, script contents, links, or a complete page dump.
export async function inspectControls(page, editorSelector) {
  if (editorSelector) {
    const edit = page.locator(editorSelector);
    if (await edit.count() !== 1) throw new Error('Edit control must be unique');
    await edit.waitFor({ state: 'visible' });
    await edit.click();
  }
  await page.locator('body').waitFor({ state: 'visible' });
  return page.evaluate(() => {
    const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    const descriptor = e => ({
      tag: e.tagName.toLowerCase(), id: e.id, class: typeof e.className === 'string' ? e.className : '',
      role: e.getAttribute('role'), type: e.getAttribute('type'),
      label: e.getAttribute('aria-label'), placeholder: e.getAttribute('placeholder'),
      text: /^(edit|save|cancel|close|basic details|name)$/i.test(e.textContent.trim()) ? e.textContent.trim() : undefined,
      visible: visible(e)
    });
    return {
      loginPage: /login|registration/i.test(location.pathname),
      controls: [...document.querySelectorAll('button, input, textarea, select, [role="dialog"], [role="button"], [class*="edit" i], [class*="modal" i], [class*="toast" i], [class*="success" i], [class*="error" i], [class*="captcha" i], [id*="edit" i], h1, h2, h3')]
        .map(descriptor).slice(0, 220),
      labels: [...document.querySelectorAll('body *')].filter(e =>
        ['Basic details', 'Name'].includes(e.textContent.trim()) && ![...e.children].some(child => child.textContent.trim() === e.textContent.trim()))
        .map(e => ({ ...descriptor(e), parents: [e.parentElement, e.parentElement?.parentElement].filter(Boolean).map(parent => ({ tag: parent.tagName.toLowerCase(), id: parent.id, class: parent.className })) })),
      statusRegions: [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live], [class*="message" i], [class*="notify" i], [class*="toast" i], [class*="success" i], [class*="error" i], [class*="validation" i], [class*="captcha" i], iframe[title]')].map(descriptor).slice(0, 80)
    };
  });
}
