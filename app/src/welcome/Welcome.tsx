// Landing screen: an editorial introduction on a first root visit, and the same screen as a modal
// dialog from "How to use". It never changes the scenario by itself: only the example button does,
// and from the dialog that is confirmed first when a different scenario is open. The long
// explanation, limitations and sources live in the About disclosure.

import { useEffect, useRef, useState } from "react";
import { EXAMPLE } from "../onboarding";
import moon from "./moonImage.json";

const exampleDate = EXAMPLE.arrival.slice(0, 10);
/** Displayed Moon size, mirrored from welcome.css (--moon) so the browser picks a suitable file. */
const MOON_SIZES = "(max-width: 860px) min(78vw, 44vh), min(58vh, 58vw, 780px)";
const base = import.meta.env.BASE_URL;

/** srcset for one format, from the shipped widths. */
export function moonSrcSet(ext: "avif" | "webp", widths: number[] = moon.widths): string {
  return widths.map((w) => `${base}welcome/moon-${w}.${ext} ${w}w`).join(", ");
}

function Arrow() {
  return (
    <svg className="lp-arrow" viewBox="0 0 20 12" aria-hidden="true" focusable="false">
      <path d="M1 6h16M12.5 1.5 17.5 6l-5 4.5" />
    </svg>
  );
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <section className="lp-about" id="lp-about" aria-labelledby="lp-about-h" data-testid="welcome-about">
      <div className="lp-about-head">
        <h2 id="lp-about-h">About this navigator</h2>
        <button type="button" className="lp-about-x" onClick={onClose} aria-label="Close About">✕</button>
      </div>
      <p>Compare sunlight, direct-to-Earth visibility and terrain steepness at documented lunar landing and study sites (plus one labelled custom-coordinate demonstration), and see what changes when arrival slips.</p>
      <h3>The south-polar example</h3>
      <p>
        A <strong>hypothetical</strong> {EXAMPLE.days}-day mission at the IM-1 Odysseus landing point (Malapert A region, near the south pole), arriving {exampleDate} UTC
        within this dataset’s dates. It is not a reconstruction or replay of the 2024 IM-1 landing. A three-step guide follows: the Sun clearing a terrain ridge,
        adding a comparison site, and a three-day arrival delay. Skip it at any time.
      </p>
      <h3>Limitations</h3>
      <p>
        Planning prototype for education and early study. Visibility is modeled geometry for the centers of the Sun and Earth at 10-minute samples, for an observer
        1 m above a terrain model. It is not flight-qualified analysis, electrical power output, a radio-link budget or a landing-safety rating.
      </p>
      <h3>Sources</h3>
      <p>
        Sun and Earth positions: NASA JPL Horizons. Terrain: NASA LRO LOLA products (and SLDEM2015, LOLA with SELENE Terrain Camera data, for Apollo 17).
      </p>
      <p>
        Moon image: {moon.source.credit}, <a href={moon.source.page} target="_blank" rel="noreferrer">CGI Moon Kit</a> colour map, derived from the{" "}
        {moon.source.derived_from}. Rendered for this app: {moon.rendering}
      </p>
      <p>
        Typefaces: Barlow Condensed (<a href={`${base}welcome/fonts/BarlowCondensed-OFL.txt`}>SIL Open Font License 1.1</a>) and Space Grotesk (
        <a href={`${base}welcome/fonts/SpaceGrotesk-OFL.txt`}>SIL Open Font License 1.1</a>), served from this site. <a href={`${base}THIRD_PARTY_LICENSES.md`}>Third-party software notices</a>.
      </p>
    </section>
  );
}

export interface WelcomeProps {
  mode: "page" | "dialog";
  /** Start the guided example (page: directly; dialog: after confirmation when needed). */
  onExplore: () => void;
  /** Page: enter the navigator. Dialog: close and keep the current scenario. */
  onOpen: () => void;
  /** Dialog only: summary of the scenario that the example would replace, or null when it is the example already. */
  current?: string | null;
}

export function Welcome({ mode, onExplore, onOpen, current = null }: WelcomeProps) {
  const [confirm, setConfirm] = useState(false);
  const [about, setAbout] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const aboutBtn = useRef<HTMLButtonElement>(null);
  const aboutRef = useRef(about);
  aboutRef.current = about;
  const dialog = mode === "dialog";
  const closeAbout = () => {
    setAbout(false);
    aboutBtn.current?.focus();
  };
  // Escape closes About first; in the dialog it then closes the dialog. The dialog keeps Tab inside
  // and returns focus to its opener.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (dialog) ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (aboutRef.current) { e.preventDefault(); closeAbout(); return; }
        if (dialog) { e.preventDefault(); onOpen(); }
        return;
      }
      if (!dialog || e.key !== "Tab") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? []);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", f);
    return () => {
      window.removeEventListener("keydown", f);
      if (!dialog) return;
      // back to the opener; if focus was nowhere in particular, to the "How to use" control
      const back = previous && previous !== document.body && previous.isConnected ? previous : document.querySelector<HTMLElement>("[data-testid=how-to-use]");
      back?.focus();
    };
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (confirm) ref.current?.querySelector<HTMLElement>("[data-keep]")?.focus();
  }, [confirm]);

  const explore = () => {
    if (dialog && current) setConfirm(true);
    else onExplore();
  };
  const content = (
    <>
      <header className="lp-top">
        <p className="lp-brand"><span className="lp-rule" aria-hidden="true" />Lunar Landing Site Navigator</p>
        <div className="lp-top-actions">
          <button type="button" className="lp-link" ref={aboutBtn} aria-expanded={about} aria-controls="lp-about" onClick={() => setAbout((a) => !a)} data-testid="welcome-about-toggle">
            About
          </button>
          {dialog && (
            <button type="button" className="lp-close" onClick={onOpen} aria-label="Close and keep the current scenario" data-testid="welcome-close">✕</button>
          )}
        </div>
      </header>
      {about && <About onClose={closeAbout} />}
      <div className="lp-hero">
        <div className="lp-stage">
          <picture className="lp-moon">
            <source type="image/avif" srcSet={moonSrcSet("avif")} sizes={MOON_SIZES} />
            <source type="image/webp" srcSet={moonSrcSet("webp")} sizes={MOON_SIZES} />
            <img
              src={`${base}welcome/${moon.fallback}`}
              width={960}
              height={960}
              alt="The near side of the Moon, from NASA LRO colour imagery."
              decoding="async"
              fetchPriority="high"
            />
          </picture>
          <h1 className="lp-headline" id="wl-title">Choose your<br />next horizon.</h1>
          <p className="lp-annot">
            <span className="lp-annot-rule" aria-hidden="true" />
            <span className="lp-annot-t">
              <strong>Odysseus · south pole</strong>
              <em>Watch the Sun clear a ridge.</em>
            </span>
          </p>
        </div>
        <p className="lp-lead" id="wl-lead">Explore terrain, sunlight and direct-to-Earth visibility.</p>
        {!confirm ? (
          <div className="lp-actions">
            <button type="button" className="lp-btn lp-primary" onClick={explore} data-autofocus data-testid="explore-example">
              <span>Watch a south-pole sunrise</span><Arrow />
            </button>
            <button type="button" className="lp-btn lp-secondary" onClick={onOpen} data-testid="open-navigator">
              {dialog ? "Back to the navigator" : "Open navigator"}
            </button>
          </div>
        ) : (
          <div className="lp-confirm" role="group" aria-labelledby="wl-confirm-h" data-testid="welcome-confirm">
            <p id="wl-confirm-h"><strong>This loads a different scenario.</strong></p>
            <p>The guided south-polar example replaces the scenario open in this tab{current ? <> ({current})</> : null}. Copy the address first if you want to keep a link to it.</p>
            <div className="lp-actions">
              <button type="button" className="lp-btn lp-primary" onClick={onExplore} data-testid="confirm-example"><span>Load the south-polar example</span><Arrow /></button>
              <button type="button" className="lp-btn lp-secondary" onClick={() => setConfirm(false)} data-keep data-testid="keep-current">Keep current scenario</button>
            </div>
          </div>
        )}
        <p className="lp-note">
          Hypothetical planning example at the IM-1 Odysseus landing point, arriving {exampleDate} UTC (dataset dates); not a replay of the 2024 IM-1 landing.
        </p>
      </div>
      <footer className="lp-foot">
        <span>Moon image: {moon.source.credit} (CGI Moon Kit, LRO LROC colour).</span>
        <span>Planning prototype · not for flight use</span>
      </footer>
    </>
  );
  if (dialog) {
    return (
      <div className="lp lp-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="wl-title" aria-describedby="wl-lead" data-testid="welcome">
        {content}
      </div>
    );
  }
  return (
    <main className="lp" ref={ref as never} data-testid="welcome-page">
      <div data-testid="welcome" className="lp-frame">{content}</div>
    </main>
  );
}
