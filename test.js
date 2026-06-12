const axios = require("axios");

async function test() {
  try {
    const resp = await axios.get("https://api.github.com");
    console.log(resp.data.current_user_url);
  } catch (err) {
    console.error(err);
  }
}

test();
