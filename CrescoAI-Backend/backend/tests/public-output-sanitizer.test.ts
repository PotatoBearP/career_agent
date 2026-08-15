import { describe, expect, test } from 'bun:test';
import { sanitizeServerPhysicalPaths } from '../src/Network/utils/publicOutputSanitizer.js';

describe('sanitizeServerPhysicalPaths', () => {
  test('preserves absolute HTTP and HTTPS links in Markdown', () => {
    const input = [
      '[HTTPS 岗位](https://www.zhaopin.com/jobdetail/CC469217510J40863318201.htm)',
      '[HTTP 岗位](http://example.com/jobs/123)',
    ].join('\n');

    expect(sanitizeServerPhysicalPaths(input)).toBe(input);
  });

  test('still hides Windows and Unix server paths', () => {
    expect(sanitizeServerPhysicalPaths('输出：C:/workspace/private/report.pdf')).toBe('输出：report.pdf');
    expect(sanitizeServerPhysicalPaths('输出：/home/user/private/report.pdf')).toBe('输出：report.pdf');
  });
});
