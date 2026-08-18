const assert = require("node:assert/strict");
const test = require("node:test");
const { displayTitleDecision, selectDisplayTitle } = require("../src/repositories/display-title");

function media(title, original_title = title, extra = {}) {
  return {
    title,
    original_title,
    metadata_status: "matched",
    metadata_confidence: 0.97,
    ...extra,
  };
}

function tmdb(alias, language = null) {
  return { alias, language, source: "tmdb" };
}

test("readable canonical Slovak and Czech titles win over aliases", () => {
  assert.equal(selectDisplayTitle(media("Počiatok"), [tmdb("Inception", "en")]), "Počiatok");
  assert.equal(selectDisplayTitle(media("Začátek"), [tmdb("Inception", "en")]), "Začátek");
});

test("native CJK, Japanese and Korean titles use trusted English aliases without changing identity", () => {
  assert.equal(selectDisplayTitle(media("嫁入高门"), [tmdb("Man Who Marry Into Wealthy Family"), tmdb("Gao Men")]), "Man Who Marry Into Wealthy Family");
  assert.equal(selectDisplayTitle(media("入戏"), [tmdb("Deep In The Act")]), "Deep In The Act");
  assert.equal(selectDisplayTitle(media("검사실의 제안"), [tmdb("A Proposal in the Prosecutors Office")]), "A Proposal in the Prosecutors Office");
});

test("explicit localized alias language is preferred and native Unicode is preserved when no safe alias exists", () => {
  assert.equal(selectDisplayTitle(media("原題"), [tmdb("Original Title", "en"), tmdb("Pôvodný názov", "sk")]), "Pôvodný názov");
  assert.equal(selectDisplayTitle(media("鬼滅の刃"), []), "鬼滅の刃");
  assert.equal(selectDisplayTitle(media("Oasis"), [tmdb("Oasis", "en")]), "Oasis");
  assert.equal(selectDisplayTitle(media("BanG Dream！梦想妄想世界"), []), "BanG Dream！梦想妄想世界");
});

test("unsafe or untrusted aliases never become display titles", () => {
  assert.equal(selectDisplayTitle(media("鬼滅の刃"), [tmdb("Movie.1080p.WEB-DL"), { alias: "Fake English", source: "filename" }]), "鬼滅の刃");
  assert.equal(selectDisplayTitle(media("鬼滅の刃", "鬼滅の刃", { metadata_status: "ambiguous" }), [tmdb("Demon Slayer")]), "鬼滅の刃");
  assert.equal(selectDisplayTitle(media("Bad\uFFFDTitle", "鬼滅の刃"), [tmdb("Demon Slayer", "en")]), "Demon Slayer");
});

test("missing fields fail safely and decision is explainable", () => {
  assert.equal(selectDisplayTitle({ title: null, original_title: null }, []), "");
  const decision = displayTitleDecision(media("결혼의 완성"), [tmdb("Marriage's Completion")]);
  assert.equal(decision.displayTitle, "Marriage's Completion");
  assert.equal(decision.reason, "TRUSTED_ENGLISH_ALIAS");
  assert.match(decision.policyVersion, /^b35-display-title-/);
});
