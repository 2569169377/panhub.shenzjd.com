import { defineEventHandler } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 动态 sitemap.xml：只收录高价值搜索词（用户真实重复搜索过的词）
 * 避免收录无限生成的 /s/ 页面，防止被搜索引擎判定为门页农场
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const siteUrl = ((config.public?.siteUrl as string) || "").replace(/\/$/, "");
  const service = getOrCreateHotSearchService();
  const terms = await service.getTopTerms(1000);

  const urls = terms
    .map((t) => {
      const loc = `${siteUrl}/s/${encodeURIComponent(t.term)}`;
      return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>weekly</changefreq>\n  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  event.node.res.setHeader("Content-Type", "application/xml; charset=utf-8");
  event.node.res.setHeader("Cache-Control", "public, max-age=3600");
  return xml;
});
