function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions || []) words[position] = word;
  }
  return words.filter(Boolean).join(" ");
}

function yearFilter(years) {
  const values = String(years || "").match(/(?:19|20)\d{2}/g)?.map(Number) || [];
  if (!values.length) return "";
  const from = Math.min(...values);
  const to = Math.max(...values);
  return `,from_publication_date:${from}-01-01,to_publication_date:${to}-12-31`;
}

function accessSource(value) {
  const url = String(value || "").toLowerCase();
  if (url.includes("arxiv.org")) return "arXiv";
  if (url.includes("openreview.net")) return "OpenReview";
  if (url.includes("openalex.org")) return "OpenAlex";
  if (/proceedings\.(?:neurips|iclr)\.cc|proceedings\.mlr\.press/.test(url)) return "conference";
  if (url.includes("doi.org")) return "publisher";
  return url ? "repository" : "";
}

export async function searchOpenAlex({ query, topic, years, count, searchMode = "lineage", signal }) {
  const searchText = String(query || topic || "").trim();
  const desired = Math.min(Math.max(Number(count) || 30, 5), 60);
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", searchText);
  url.searchParams.set("filter", `${searchMode === "readable" ? "is_oa:true" : "type:article|preprint"}${yearFilter(years)}`);
  url.searchParams.set("sort", "relevance_score:desc,cited_by_count:desc");
  url.searchParams.set("per-page", String(Math.min(desired * 2, 100)));
  url.searchParams.set("select", "id,doi,title,publication_year,authorships,primary_location,best_oa_location,locations,open_access,abstract_inverted_index,cited_by_count,relevance_score,type");

  let response;
  try {
    response = await fetch(url, { signal, headers: { "user-agent": "ResearchTreeStudio/2.0 (local research tool)" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw Object.assign(new Error("公开论文检索服务暂时无法访问，请稍后重试。"), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(`公开论文检索失败（HTTP ${response.status}）。`), { status: 502 });
  const body = await response.json();
  return (body.results || []).map((work, index) => {
    const abstract = abstractFromInvertedIndex(work.abstract_inverted_index).slice(0, 5000);
    const accessUrl = work.doi || work.primary_location?.landing_page_url || work.id || "";
    const pdfUrl = work.best_oa_location?.pdf_url || work.primary_location?.pdf_url || (work.locations || []).find(location => location?.pdf_url)?.pdf_url || "";
    const source = accessSource(pdfUrl || accessUrl);
    const accessStatus = pdfUrl ? "open_pdf" : work.open_access?.is_oa === false && accessUrl ? "institutional_required" : abstract ? "abstract_only" : accessUrl ? "metadata_only" : "unavailable";
    const analysisBasis = abstract ? "abstract" : "metadata";
    return {
      sourceId: work.id || `openalex-${index + 1}`,
      title: work.title || "",
      year: work.publication_year || 0,
      authors: (work.authorships || []).slice(0, 8).map(item => item.author?.display_name).filter(Boolean).join(", "),
      venue: work.primary_location?.source?.display_name || work.type || "",
      doi: work.doi || "",
      url: accessUrl,
      accessUrl,
      pdfUrl,
      accessStatus,
      accessSource: source || "OpenAlex",
      analysisBasis,
      analysisConfidence: analysisBasis === "abstract" ? 0.68 : 0.32,
      citedByCount: work.cited_by_count || 0,
      relevanceScore: Number(work.relevance_score) || 0,
      abstract
    };
  }).filter(item => item.title);
}
