// Entry for the standalone sonar test page (/sonar/).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SonarLabPage } from './SonarLab.tsx';
import './sonar-lab.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SonarLabPage />
  </StrictMode>
);
