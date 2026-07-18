import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Github, MessageCircle, Phone, QrCode, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import wechatQr from '../assets/contact/wechat-cle.jpg';
import './AboutContactSection.css';

const CONTACT = {
  github: {
    display: '@Cle0726',
    value: 'https://github.com/Cle0726',
  },
  qq: {
    display: '3478658158',
    value: '3478658158',
    url: 'https://wpa.qq.com/msgrd?v=3&uin=3478658158&site=qq&menu=yes',
  },
  phone: {
    display: '156 7814 4635',
    value: '15678144635',
    url: 'tel:+8615678144635',
  },
} as const;

type CopyTarget = 'github' | 'qq' | 'phone' | null;

async function writeClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = value;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }
}

export function AboutContactSection() {
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [showWechatQr, setShowWechatQr] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const modalCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showWechatQr) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowWechatQr(false);
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => modalCloseRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showWechatQr]);

  const copyContact = async (target: Exclude<CopyTarget, null>, value: string) => {
    await writeClipboard(value);
    setCopied(target);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(null);
      copyTimerRef.current = null;
    }, 1800);
  };

  const openContact = async (url: string, copyTarget?: Exclude<CopyTarget, null>, copyValue?: string) => {
    try {
      await openUrl(url);
    } catch {
      if (copyTarget && copyValue) await copyContact(copyTarget, copyValue);
    }
  };

  const renderCopyButton = (
    target: Exclude<CopyTarget, null>,
    value: string,
    label: string,
  ) => (
    <button
      type="button"
      className={`about-contact-copy${copied === target ? ' is-copied' : ''}`}
      onClick={() => void copyContact(target, value)}
      aria-label={label}
      title={label}
    >
      {copied === target ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );

  return (
    <section className="about-contact-section" aria-labelledby="about-contact-heading">
      <header className="about-contact-heading">
        <div>
          <p className="about-contact-eyebrow">CONTACT / CONNECT</p>
          <h3 id="about-contact-heading">联系与合作 <span>Get in touch</span></h3>
        </div>
        <div className="about-contact-heading-mark" aria-hidden="true">
          <span />
          04
        </div>
      </header>

      <div className="about-contact-grid">
        <article className="about-contact-card about-contact-card--github">
          <div className="about-contact-card-topline">
            <span className="about-contact-icon"><Github aria-hidden="true" /></span>
            <span className="about-contact-index">01</span>
          </div>
          <div className="about-contact-copyblock">
            <p>GitHub <span>CODE & PROJECTS</span></p>
            <strong>{CONTACT.github.display}</strong>
          </div>
          <div className="about-contact-actions">
            <button
              type="button"
              className="about-contact-open"
              onClick={() => void openContact(CONTACT.github.value)}
            >
              访问主页 <span>OPEN</span><ExternalLink aria-hidden="true" />
            </button>
            {renderCopyButton('github', CONTACT.github.value, '复制 GitHub 地址 / Copy GitHub URL')}
          </div>
        </article>

        <article className="about-contact-card about-contact-card--wechat">
          <div className="about-contact-card-topline">
            <span className="about-contact-icon"><QrCode aria-hidden="true" /></span>
            <span className="about-contact-index">02</span>
          </div>
          <div className="about-contact-copyblock">
            <p>微信 <span>WECHAT</span></p>
            <strong>扫码添加 / Scan to connect</strong>
          </div>
          <div className="about-contact-actions">
            <button
              type="button"
              className="about-contact-open"
              onClick={() => setShowWechatQr(true)}
            >
              查看二维码 <span>SHOW QR</span><QrCode aria-hidden="true" />
            </button>
          </div>
        </article>

        <article className="about-contact-card about-contact-card--qq">
          <div className="about-contact-card-topline">
            <span className="about-contact-icon"><MessageCircle aria-hidden="true" /></span>
            <span className="about-contact-index">03</span>
          </div>
          <div className="about-contact-copyblock">
            <p>QQ <span>INSTANT MESSAGE</span></p>
            <strong>{CONTACT.qq.display}</strong>
          </div>
          <div className="about-contact-actions">
            <button
              type="button"
              className="about-contact-open"
              onClick={() => void openContact(CONTACT.qq.url, 'qq', CONTACT.qq.value)}
            >
              发起会话 <span>MESSAGE</span><ExternalLink aria-hidden="true" />
            </button>
            {renderCopyButton('qq', CONTACT.qq.value, '复制 QQ 号 / Copy QQ number')}
          </div>
        </article>

        <article className="about-contact-card about-contact-card--phone">
          <div className="about-contact-card-topline">
            <span className="about-contact-icon"><Phone aria-hidden="true" /></span>
            <span className="about-contact-index">04</span>
          </div>
          <div className="about-contact-copyblock">
            <p>联系电话 <span>PHONE</span></p>
            <strong>{CONTACT.phone.display}</strong>
          </div>
          <div className="about-contact-actions">
            <button
              type="button"
              className="about-contact-open"
              onClick={() => void openContact(CONTACT.phone.url, 'phone', CONTACT.phone.value)}
            >
              拨打电话 <span>CALL</span><Phone aria-hidden="true" />
            </button>
            {renderCopyButton('phone', CONTACT.phone.value, '复制联系电话 / Copy phone number')}
          </div>
        </article>
      </div>

      <footer className="about-contact-footer">
        <span className="about-contact-status-dot" aria-hidden="true" />
        <span>欢迎交流与合作</span>
        <span className="about-contact-footer-en">OPEN FOR CONVERSATION & COLLABORATION</span>
      </footer>

      {showWechatQr && (
        <div
          className="wechat-qr-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShowWechatQr(false);
          }}
        >
          <section
            className="wechat-qr-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wechat-qr-title"
          >
            <header className="wechat-qr-dialog-header">
              <div>
                <p>WECHAT / CONNECT</p>
                <h4 id="wechat-qr-title">微信扫一扫 <span>Scan with WeChat</span></h4>
              </div>
              <button
                ref={modalCloseRef}
                type="button"
                className="wechat-qr-close"
                onClick={() => setShowWechatQr(false)}
                aria-label="关闭二维码 / Close QR code"
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="wechat-qr-image-shell">
              <img src={wechatQr} alt="C.le. 微信二维码" />
              <span className="wechat-qr-corner wechat-qr-corner--tl" aria-hidden="true" />
              <span className="wechat-qr-corner wechat-qr-corner--br" aria-hidden="true" />
            </div>
            <footer className="wechat-qr-dialog-footer">
              <span className="about-contact-status-dot" aria-hidden="true" />
              扫码添加 C.le. 为好友
              <span>SCAN TO ADD C.LE.</span>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
