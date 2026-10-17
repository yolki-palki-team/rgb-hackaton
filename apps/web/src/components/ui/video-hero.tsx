'use client';

// Adapted from Velorah by MohammadShehadeh (MIT). See public/hero/ATTRIBUTION.md.
import { useEffect, useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import SiteHeader from './site-header';

export default function VideoHero() {
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true;
    const sync = () => {
      if (!visible || document.hidden || reduced.matches) video.pause();
      else
        void video.play().catch(() => {
          /* Keep the poster if autoplay is unavailable. */
        });
    };
    const onPreference = sync;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(root);
    video.addEventListener('canplay', sync);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', onPreference);
    sync();
    return () => {
      observer.disconnect();
      video.pause();
      video.removeEventListener('canplay', sync);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', onPreference);
    };
  }, []);

  return (
    <section className="video-hero" ref={rootRef} aria-labelledby="hero-title">
      <video
        ref={videoRef}
        className="video-hero-media"
        src="/hero/prisma.mp4"
        poster="/hero/prisma-poster.jpg"
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="video-hero-shade" aria-hidden="true" />
      <SiteHeader active="home" />
      <div className="video-hero-copy">
        <p className="video-hero-eyebrow">A2A · RGB</p>
        <h1 id="hero-title">Swap beyond pairs.</h1>
        <p className="video-hero-description">BTC + RGB. Local AI. Your keys.</p>
        <a className="video-hero-glass video-hero-primary" href="/market">
          Explore orders <ArrowUpRight size={19} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
