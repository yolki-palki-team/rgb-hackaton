import { walletUrl } from '../../wallet-url';
export default function SiteHeader({ active }: { active: 'home' | 'market' }) {
  return (
    <nav className="video-hero-nav" aria-label="Primary">
      <a className="video-hero-brand" href="/" aria-label="pálka. home">
        p<span className="brand-stress">a</span>lka.
      </a>
      <div className="video-hero-links">
        <a href="/" aria-current={active === 'home' ? 'page' : undefined}>
          Home
        </a>
        <a href="/market" aria-current={active === 'market' ? 'page' : undefined}>
          Market
        </a>
        <a href={walletUrl} target="_blank" rel="noopener noreferrer">
          Local wallet
        </a>
      </div>
    </nav>
  );
}
