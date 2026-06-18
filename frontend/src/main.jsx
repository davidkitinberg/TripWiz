/**
 * @fileoverview React application entry point; mounts the root component into the DOM.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

createRoot(document.getElementById('root')).render(<App />);
