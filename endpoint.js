const axios = require("axios");
const fs = require("fs");

async function main() {
  try {
    const apiKey = "i8dfso8lcqtqg08xidr90kgexez9nxpme4f4fk07"; // tvoj API key

    // 1. Získa profil používateľa
    const profileResp = await axios.get("https://proxy.webshare.io/api/v2/profile/", {
      headers: { "Authorization": `Token ${apiKey}` }
    });
    console.log("Prihlaseny profil:", profileResp.data);

    // 2. Získa zoznam proxy serverov dostupných cez API key
    const proxiesResp = await axios.get("https://proxy.webshare.io/api/v2/proxies/", {
      headers: { "Authorization": `Token ${apiKey}` }
    });

    // 3. Uloženie výsledkov do files.json
    fs.writeFileSync("files.json", JSON.stringify(proxiesResp.data, null, 2), "utf-8");
    console.log(`Úspešne uložené ${proxiesResp.data.length} proxy položiek do files.json`);

  } catch (err) {
    console.error("Chyba:", err.message);
  }
}

main();
