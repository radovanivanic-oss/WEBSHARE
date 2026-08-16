const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const fs = require("fs").promises;

function getWebshareWst(env = process.env) {
  const value = env.WEBSHARE_WST;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("WEBSHARE_WST is required.");
  }
  return value;
}

const chars = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

// Funkcia na stiahnutie videí pre konkrétny filter
async function fetchVideosForFilter(filter, { wstToken = getWebshareWst(), client = axios, parse = parseStringPromise } = {}) {
  const allFiles = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    try {
      const params = new URLSearchParams({
        what: filter + "*",
        limit: limit,
        offset: offset,
        sort: "recent",
        category: "video",
        wst: wstToken
      });

      const resp = await client.post(
        "https://webshare.cz/api/search/",
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const json = await parse(resp.data);
      const files = json.response.file || [];

      if (files.length === 0) break;

      files.forEach(f => allFiles.push({
        id: f.ident?.[0],
        name: f.name?.[0],
        size: f.size?.[0],
        type: f.type?.[0],
        downloads: f.downloads?.[0],
        create_time: f.create_time?.[0]
      }));

      offset += files.length;

    } catch (err) {
      console.error("Webshare search request failed.");
      break;
    }
  }

  return allFiles;
}

// ------------------------ Hlavné spustenie ------------------------
async function main({ wstToken = getWebshareWst(), client = axios, parse = parseStringPromise, fileSystem = fs } = {}) {
  const allVideos = [];

  for (const first of chars) {
    console.log(`Sťahujem videá začínajúce na "${first}"...`);

    // najprv stiahnuť filtra bez druhého znaku (iba "a*", "b*", ...)
    const videosSingle = await fetchVideosForFilter(first, { wstToken, client, parse });
    allVideos.push(...videosSingle);
    console.log(`- Nájdol som ${videosSingle.length} videí pre "${first}*"`);

    // potom dvojúrovňové filtrovanie (napr. "aa*", "ab*", "ac*", ...)
    for (const second of chars) {
      const filter = first + second;
      const videosDouble = await fetchVideosForFilter(filter, { wstToken, client, parse });
      if (videosDouble.length > 0) {
        allVideos.push(...videosDouble);
        console.log(`- Našiel som ${videosDouble.length} videí pre "${filter}*"`);
      }
    }
  }

  // odstránenie duplicitných videí podľa ID
  const uniqueVideos = Array.from(new Map(allVideos.map(v => [v.id, v])).values());

  // uloženie do súboru
  try {
    await fileSystem.writeFile("videos_all.json", JSON.stringify(uniqueVideos, null, 2), "utf-8");
    console.log(`✅ Úspešne uložené ${uniqueVideos.length} videí do videos_all.json`);
    return uniqueVideos;
  } catch (err) {
    console.error("Webshare catalog output failed.");
    return [];
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getWebshareWst, fetchVideosForFilter, main };
