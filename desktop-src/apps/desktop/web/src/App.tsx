import { useState } from 'react';
import { ApiServicesPage } from './pages/ApiServicesPage';
import { ClaudeWebGatewayPage } from './pages/ClaudeWebGatewayPage';
import { MultiPlatformProxyPage } from './pages/MultiPlatformProxyPage';

type PageKey = 'services' | 'multi' | 'claude';

export default function App() {
  const [page, setPage] = useState<PageKey>('services');

  return (
    <>
      <nav className="top-nav">
        <button className={page === 'services' ? 'primary' : 'secondary'} onClick={() => setPage('services')}>
          API 服务
        </button>
        <button className={page === 'multi' ? 'primary' : 'secondary'} onClick={() => setPage('multi')}>
          多平台 API 反代
        </button>
        <button className={page === 'claude' ? 'primary' : 'secondary'} onClick={() => setPage('claude')}>
          Claude 反代接口
        </button>
      </nav>
      {page === 'services' ? (
        <ApiServicesPage onOpenMultiProxy={() => setPage('multi')} onOpenClaudeGateway={() => setPage('claude')} />
      ) : null}
      {page === 'multi' ? <MultiPlatformProxyPage /> : null}
      {page === 'claude' ? <ClaudeWebGatewayPage /> : null}
    </>
  );
}
