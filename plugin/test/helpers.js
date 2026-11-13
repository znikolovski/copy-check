import { DOMParser as LinkedomParser } from 'linkedom';

/** Browser-like DOMParser: linkedom does not wrap bare fragments in <html><body>. */
export class DOMParser {
  parseFromString(html, type) {
    const wrapped = /<html[\s>]/i.test(html) ? html
      : `<!DOCTYPE html><html><head></head>${/<body[\s>]/i.test(html) ? html : `<body>${html}</body>`}</html>`;
    return new LinkedomParser().parseFromString(wrapped, type);
  }
}

export const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

/** A page in the editor's live HTML shape. */
export const LIVE_PAGE = `<body><header></header><main>
<div>
  <h1 data-prose-index="1">Welcome to teh new site</h1>
  <p data-prose-index="30">We   recieve feedback  from <strong>every</strong> customer. <a href="/contact">click here</a> to talk.</p>
  <p><picture><img src="./media_1.png" alt="A teh cup of coffee"></picture></p>
  <div class="cards" data-block-index="120">
    <div><div><picture><img src="./media_2.png" alt=""></picture></div><div><p>First card is is great.</p><p>Built on aem with edge delivery services.</p></div></div>
    <div><div>Second card</div><div>Visit <a href="https://www.example.com/x">adobe.com</a> today.</div></div>
  </div>
  <div class="section-metadata"><div><div>style</div><div>dark</div></div></div>
</div>
<div>
  <ul><li>One item</li><li>Two items<ul><li>Nested item</li></ul></li></ul>
  <pre><code>const x = teh;</code></pre>
  <div class="hero" data-block-index="400"><div><div><h2>Best in class platform</h2></div></div></div>
  <div class="metadata"><div><div>Title</div><div>Copy Check demo</div></div><div><div>Description</div><div>A page to demo teh checker.</div></div></div>
</div>
</main><footer></footer></body>`;
