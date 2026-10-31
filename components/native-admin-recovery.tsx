/* eslint-disable @next/next/no-html-link-for-pages -- Native authentication must navigate the top document. */
import {chatGPTSignInPath} from '../app/chatgpt-auth';
import ConnectedAccountMenu from './connected-account-menu';
export default function NativeAdminRecovery(){return <main className="admin-entry-page"><section className="admin-entry"><header><a href="/">Your business</a><ConnectedAccountMenu/></header><h1>Continue to administration</h1><p>Open the secure site sign-in to continue.</p><a className="button" href={chatGPTSignInPath('/admin')} target="_top">Continue to administration</a></section></main>;}
