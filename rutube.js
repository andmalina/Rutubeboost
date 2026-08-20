const HOSTS = new Set(["rutube.ru", "www.rutube.ru"]);

export function parseRutube(raw) {
  if (!raw || typeof raw !== "string") return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = url.pathname.replace(/\/+$/, "") + "/";
  const video = path.match(
    /^\/(?:video\/(?:private\/)?|play\/embed\/|shorts\/)([a-zA-Z0-9]+)\/?/,
  );
  if (video) {
    return {
      kind: "video",
      id: video[1],
      p: url.searchParams.get("p") || null,
      pageUrl: `https://rutube.ru/video/${video[1]}/`,
      embedUrl: embedUrl(video[1], url.searchParams.get("p")),
    };
  }

  const channel = path.match(/^\/(u|channel)\/([^/]+)\/?/);
  if (channel) {
    return {
      kind: "channel",
      id: channel[2],
      channelUrl: `https://rutube.ru/${channel[1]}/${channel[2]}/`,
    };
  }
  return null;
}

export function embedUrl(id, p) {
  const base = `https://rutube.ru/play/embed/${id}`;
  const params = new URLSearchParams();
  params.set("skinColor", "ff2d00");
  if (p) params.set("p", p);
  return `${base}?${params.toString()}`;
}

export function thumbUrl(id) {
  return `https://rutube.ru/api/video/${id}/thumbnail/?redirect=1`;
}

export async function fetchMeta(parsed) {
  if (!parsed || parsed.kind !== "video") {
    return {
      title: parsed?.kind === "channel" ? `Канал ${parsed.id}` : null,
      author: null,
      thumb: null,
      duration: null,
      channelUrl: parsed?.channelUrl || null,
    };
  }

  const id = parsed.id;
  const fallback = {
    title: null,
    author: null,
    thumb: thumbUrl(id),
    duration: null,
    channelUrl: null,
  };

  const endpoints = [
    `https://rutube.ru/api/video/${id}/`,
    `https://rutube.ru/api/oembed/?url=${encodeURIComponent(parsed.pageUrl)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(endpoint, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "RutubeBoost/1.0 (+https://rutubeboost.local)",
          Accept: "application/json",
        },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      return {
        title: json.title || json.author_name || fallback.title,
        author:
          json.author?.name ||
          json.author_name ||
          json.author ||
          fallback.author,
        thumb:
          json.thumbnail_url ||
          json.thumbnail?.url ||
          json.picture_url ||
          fallback.thumb,
        duration: json.duration || null,
        channelUrl:
          json.author?.site_url ||
          json.author_url ||
          json.author?.url ||
          fallback.channelUrl,
      };
    } catch {
      /* Rutube may be unreachable from some hosts */
    }
  }
  return fallback;
}
