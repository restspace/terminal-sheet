import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './app/App';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
