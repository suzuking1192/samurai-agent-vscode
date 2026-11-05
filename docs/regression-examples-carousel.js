/**
 * Regression Examples Carousel
 * Data shape: { id, title, subtitle, codeLines: [{ no, html, highlight? }], bullets, closing }
 */
const { useState, useEffect, useCallback } = React;

const HIGHLIGHT_CLASS =
  "-mx-1 my-0.5 inline-block border-l-2 border-amber-500 bg-amber-500/10 py-0.5 pl-2 pr-1 text-amber-300";
const LINE_NO_CLASS = "select-none text-slate-600";

const PILL_LABELS = ["Retry Logic", "Nested HTML", "Regex Data Loss"];

const REGESSION_EXAMPLES = [
  {
    id: "retry-timeout",
    title: "Retry logic conflict (timeouts vs backoff)",
    subtitle:
      "Samurai found a regression that looks fine in PR review but breaks under real rate limits.",
    codeLines: [
      { no: 1, html: <span className="text-slate-500">// Retry with backoff</span> },
      {
        no: 2,
        html: (
          <>
            <span className="text-purple-400">const</span> backoffs = [
            <span className="text-amber-300">15000</span>,{" "}
            <span className={HIGHLIGHT_CLASS}>30000</span>];{" "}
            <span className="text-slate-500">// 15s, 30s</span>
          </>
        ),
      },
      {
        no: 3,
        html: (
          <>
            <span className="text-purple-400">const</span> controller ={" "}
            <span className="text-purple-400">new</span>{" "}
            <span className="text-blue-300">AbortController</span>();
          </>
        ),
      },
      {
        no: 4,
        html: (
          <span className="text-slate-500">
            // Global timeout: 30s — aborts before retry #2 runs
          </span>
        ),
      },
      {
        no: 5,
        html: (
          <>
            <span className="text-slate-400">setTimeout</span>(
            () => controller.<span className="text-slate-400">abort</span>(),{" "}
            <span className={HIGHLIGHT_CLASS}>30000</span>);
          </>
        ),
      },
      { no: 6, html: null },
      {
        no: 7,
        html: (
          <>
            <span className="text-purple-400">for</span> (
            <span className="text-purple-400">let</span> i ={" "}
            <span className="text-amber-300">0</span>; i &lt; backoffs.
            <span className="text-slate-400">length</span>; i++) {"{"}
          </>
        ),
      },
      {
        no: 8,
        html: (
          <>
            {"  "}
            <span className="text-purple-400">await</span>{" "}
            <span className="text-slate-400">sleep</span>(backoffs[i]);
          </>
        ),
      },
      {
        no: 9,
        html: (
          <>
            {"  "}
            <span className="text-purple-400">await</span>{" "}
            <span className="text-slate-400">fetch</span>(url,{" "}
            {"{ signal: controller.signal }"});
          </>
        ),
      },
      {
        no: 10,
        html: "}",
      },
    ],
    bullets: [
      "Global timeout aborts before retry #2 runs",
      "Second retry never executes",
    ],
    closing:
      "These are the reliability regressions Samurai is designed to catch.",
  },
  {
    id: "nested-html",
    title: "UI regression (invalid nested HTML)",
    subtitle:
      "AI implemented GIF email support, but preview rendering became invalid HTML.",
    codeLines: [
      {
        no: 1,
        html: (
          <span className="text-slate-500">
            // compileTemplate wraps output with full document
          </span>
        ),
      },
      {
        no: 2,
        html: (
          <>
            <span className="text-purple-400">const</span> html ={" "}
            <span className="text-slate-400">compileTemplate</span>(data);{" "}
            <span className="text-slate-500">// returns </span>
            <span className={HIGHLIGHT_CLASS}>{"<!DOCTYPE html><html><body>..."}</span>
          </>
        ),
      },
      { no: 3, html: null },
      {
        no: 4,
        html: (
          <span className="text-slate-500">
            // EmailPreview injects into a div
          </span>
        ),
      },
      {
        no: 5,
        html: (
          <>
            <span className="text-slate-400">return</span> (
            <span className="text-amber-300">{"<div>"}</span>{" "}
            <span className={HIGHLIGHT_CLASS}>dangerouslySetInnerHTML</span>
            {"={{ __html: html }}"} {" />)"};
          </>
        ),
      },
      { no: 6, html: null },
      {
        no: 7,
        html: (
          <span className="text-slate-500">
            {"// Result: nested <html>/<body> inside div → invalid DOM"}
          </span>
        ),
      },
    ],
    bullets: [
      "Full HTML document injected into a <div> → invalid DOM",
      "Causes rendering inconsistencies / style collisions",
      "Fix: iframe srcDoc OR compileTemplate returns inner HTML for preview",
    ],
    closing:
      "Samurai catches UI regressions caused by seemingly 'correct' HTML changes.",
  },
  {
    id: "regex-data-loss",
    title: "Silent data loss (over-broad cleanup regex)",
    subtitle: "A safer-looking regex change started deleting user content.",
    codeLines: [
      {
        no: 1,
        html: (
          <span className="text-slate-500">
            {"// Old: only template variables {{ word }}"}
          </span>
        ),
      },
      {
        no: 2,
        html: (
          <>
            <span className="text-slate-400">const</span> oldRegex ={" "}
            <span className="text-amber-300">{"/\\{\\{\\}(\\w+)\\}\\\\}/g"}</span>;
          </>
        ),
      },
      {
        no: 3,
        html: (
          <span className="text-slate-500">
            {"// New: any {{ ... }} — over-broad"}
          </span>
        ),
      },
      {
        no: 4,
        html: (
          <>
            <span className="text-slate-400">const</span> newRegex ={" "}
            <span className={HIGHLIGHT_CLASS}>{"/\\{\\{[^}]+\\}\\\\}/g"}</span>;
          </>
        ),
      },
      { no: 5, html: null },
      {
        no: 6,
        html: (
          <span className="text-slate-500">
            // User email contains code sample:
          </span>
        ),
      },
      {
        no: 7,
        html: (
          <>
            <span className="text-purple-400">const</span> x ={" "}
            <span className={HIGHLIGHT_CLASS}>{"{{ id: 1 }}"}</span>{" "}
            <span className="text-slate-500">// gets deleted silently</span>
          </>
        ),
      },
    ],
    bullets: [
      "Broad cleanup deletes valid content, not just template variables",
      "No crash — output is silently corrupted",
      "Fix: constrain cleanup or escape code blocks / only remove known tags",
    ],
    closing: "Samurai flags destructive changes that tests often miss.",
  },
];

function CodeLine({ no, html, highlight }) {
  const pad = no >= 10 ? " " : "  ";
  return (
    <div>
      <span className={LINE_NO_CLASS}>{pad}{no} </span>
      {highlight ? (
        <span className={HIGHLIGHT_CLASS}>{html}</span>
      ) : (
        html
      )}
    </div>
  );
}

function RegressionExamplesCarousel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const total = REGESSION_EXAMPLES.length;
  const example = REGESSION_EXAMPLES[currentIndex];

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + total) % total);
  }, [total]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % total);
  }, [total]);

  const goTo = useCallback((index) => {
    setCurrentIndex(index);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    const el = document.getElementById("regression-carousel-focus");
    if (!el) return;
    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [goPrev, goNext]);

  return (
    <div>
      <h2 className="text-center text-3xl font-semibold text-white sm:text-4xl">
        Real regression Samurai caught
      </h2>
      <p className="mt-6 text-center text-lg text-slate-300">
        Regression examples Samurai caught across different scenarios:
      </p>

      <div
        id="regression-carousel-focus"
        tabIndex={0}
        role="region"
        aria-label="Regression examples carousel"
        className="mt-8 outline-none"
      >
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          {/* Card header: warning bar + slide counter */}
          <div className="flex items-center justify-between border-b border-slate-700 bg-slate-800/80 px-4 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-amber-400/90" aria-hidden="true">
                &#x26A0;
              </span>
              <span className="text-slate-400">Regression detected</span>
            </div>
            <span className="text-slate-400" aria-live="polite">
              {currentIndex + 1} / {total}
            </span>
          </div>

          {/* Slide content */}
          <div
            key={example.id}
            className="transition-opacity duration-300"
            style={{ minHeight: "280px" }}
          >
            {/* Title row + arrows inside card */}
            <div className="flex items-start justify-between gap-4 border-b border-slate-700 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-white">{example.title}</h3>
                <p className="mt-1 text-sm text-slate-400">{example.subtitle}</p>
              </div>
              <div className="flex flex-shrink-0 gap-1">
                <button
                  type="button"
                  onClick={goPrev}
                  aria-label="Previous slide"
                  className="rounded-lg p-2.5 text-slate-300 transition hover:bg-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  aria-label="Next slide"
                  className="rounded-lg p-2.5 text-slate-300 transition hover:bg-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto bg-slate-950 px-4 py-4 font-mono text-sm leading-relaxed text-slate-300">
              <div className="min-h-[200px] min-w-max space-y-0.5">
                {example.codeLines.map((line) => (
                  <CodeLine
                    key={line.no}
                    no={line.no}
                    html={line.html}
                    highlight={line.highlight}
                  />
                ))}
              </div>
            </div>

            <div className="border-t border-slate-700 px-4 py-4">
              <ul className="list-inside list-disc space-y-1 text-slate-300">
                {example.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
              <p className="mt-4 font-semibold text-white">{example.closing}</p>
            </div>
          </div>
        </div>

        {/* Labeled pills + hint */}
        <div className="mt-4 space-y-3">
          <div
            className="flex flex-wrap justify-center gap-2"
            role="tablist"
            aria-label="Regression example categories"
          >
            {REGESSION_EXAMPLES.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-label={`Go to ${PILL_LABELS[i]}`}
                aria-selected={currentIndex === i}
                onClick={() => goTo(i)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 ${
                  currentIndex === i
                    ? "border border-slate-400 bg-slate-700 text-white"
                    : "border border-slate-600 bg-slate-800/60 text-slate-400 hover:border-slate-500 hover:text-slate-300"
                }`}
              >
                {PILL_LABELS[i]}
              </button>
            ))}
          </div>
          <p className="text-center text-sm text-slate-500">
            ← See more real regressions →
          </p>
        </div>
      </div>
    </div>
  );
}

(function initRegressionCarousel() {
  try {
    if (typeof React === "undefined" || typeof ReactDOM === "undefined") {
      throw new Error("React or ReactDOM not loaded");
    }
    const container = document.getElementById("regression-examples-carousel");
    if (!container) return;
    const root = ReactDOM.createRoot(container);
    root.render(<RegressionExamplesCarousel />);
  } catch (e) {
    console.error("Regression carousel init error:", e);
  }
})();
