/**
 * Language text on a real client (applications/languages.mts): a tagged passage enriches to its language, and the
 * GM reads it plainly, marked; the editor offers the tags. Who else reads it is the helpers' (test/languages.test.mjs).
 */
export function registerLanguageTests(quench) {
  quench.registerBatch("wildpath.languages", context => {
    const {describe,it,assert} = context;
    describe("Language text (GM)", function () {
      this.timeout(30000);

      it("a tagged passage enriches to its language; the GM reads it plainly, marked", async function () {
        const html = await foundry.applications.ux.TextEditor.implementation.enrichHTML("<p>[elvish]Well met[/elvish], friend</p>");
        const holder = document.createElement("div");
        holder.innerHTML = html;
        document.body.append(holder);
        try {
          const span = holder.querySelector(".wildpath-language");
          assert.exists(span,"its passage");
          assert.equal(span.dataset.language,"elvish");
          assert.equal(span.textContent,"Well met");
          assert.isTrue(span.classList.contains("wildpath-language-gm"),"the GM's view, marked");
          assert.include(holder.textContent,", friend","the untagged text is untouched");
        } finally {
          holder.remove();
        }
      });

      it("the editor's Language menu wraps a selection in a tag", async function () {
        const menus = {};
        Hooks.callAll("getProseMirrorMenuDropDowns",null,menus);
        const elvish = menus.wildpathLanguage?.entries?.find(entry => entry.action === "wildpath-language-elvish");
        assert.exists(elvish);
        const replaced = [];
        const state = {selection:{from:2,to:7},doc:{textBetween:() => "hello"},tr:{insertText:(text,from,to) => ({text,from,to})}};
        elvish.cmd(state,transaction => replaced.push(transaction));
        assert.deepEqual(replaced,[{text:"[elvish]hello[/elvish]",from:2,to:7}]);
      });
    });
  }, {displayName:"WILDPATH: Languages",preSelected:false});
}
