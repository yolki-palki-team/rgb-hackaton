"use client";

// Adapted from Velorah by MohammadShehadeh (MIT). See public/hero/ATTRIBUTION.md.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Pause, Play } from 'lucide-react';

export default function VideoHero() {
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const manualPause = useRef(false);
  const manualPlay = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true;
    const sync = () => {
      if (!visible || document.hidden || manualPause.current || (reduced.matches && !manualPlay.current)) video.pause();
      else void video.play().catch(() => setPlaying(false));
    };
    const onPreference = () => { manualPlay.current = false; sync(); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(root);
    video.addEventListener('canplay', sync);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', onPreference);
    sync();
    return () => {
      observer.disconnect(); video.pause();
      video.removeEventListener('canplay', sync);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', onPreference);
    };
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      manualPause.current = false; manualPlay.current = true;
      void video.play().catch(() => setPlaying(false));
    } else { manualPause.current = true; video.pause(); }
  };

  return <section className="video-hero" ref={rootRef} aria-labelledby="hero-title">
    <video ref={videoRef} className="video-hero-media" src="/hero/velorah.mp4" poster="/hero/velorah-poster.jpg" muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} />
    <div className="video-hero-shade" aria-hidden="true" />
    <nav className="video-hero-nav" aria-label="Primary">
      <a className="video-hero-brand" href="/" aria-label="palka home">palka</a>
      <div className="video-hero-links"><a href="/" aria-current="page">Home</a><a href="/market">Market</a><a href="http://127.0.0.1:4101/" target="_blank" rel="noopener noreferrer">Local wallet</a></div>
      <a className="video-hero-glass video-hero-nav-cta" href="/market">Explore market <ArrowUpRight size={16} aria-hidden="true" /></a>
    </nav>
    <div className="video-hero-copy">
      <p className="video-hero-eyebrow">A2A · RGB</p>
      <h1 id="hero-title">An exchange<br />that comes together.</h1>
      <p className="video-hero-description">Publish an intent and find a direct match or a three-party ring. Your keys and final decision stay in your local wallet.</p>
      <a className="video-hero-glass video-hero-primary" href="/market">Explore orders <ArrowUpRight size={19} aria-hidden="true" /></a>
    </div>
    {!failed && <button className="video-hero-playback video-hero-glass" type="button" onClick={togglePlayback} aria-label={playing ? 'Pause background video' : 'Play background video'}>{playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}<span>{playing ? 'Pause motion' : 'Play motion'}</span></button>}
  </section>;
}
