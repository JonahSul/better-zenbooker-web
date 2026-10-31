import {elementRegistry,ELEMENT_REGISTRY_VERSION} from './element-measurement-core';
export const elementGtmManifest={
 format:'declarative-configuration-not-importable',version:'element-gtm-v1',registryVersion:ELEMENT_REGISTRY_VERSION,
 routes:['/','/privacy','/terms'],events:['element_view','element_action'],
 trigger:{type:'custom_event',eventNamePattern:'^element_(view|action)$'},
 tag:{type:'GA4_event',googleTag:'reuse_existing_published_google_tag',eventName:'{{Event}}',requiredConsent:['analytics_storage'],automaticUserProvidedData:false,automaticFormInteractions:false,historyPageViews:false,duplicatePageView:false,eventParameterOverrides:{page_location:'{{DLV - page_location}}',page_referrer:'{{DLV - page_referrer}}'}},
 dataLayerVariables:['page_location','page_referrer','element_id','element_placement','element_route','snapshot_hash','asset_manifest_hash','renderer_version','registry_version'],
 eventScopedCustomDimensions:['element_id','element_placement','element_route','renderer_version','registry_version'],
 elementIds:elementRegistry.map(item=>item.id),
 prohibitedFields:['documentId','documentKey','grantId','subject','user_id','name','email','phone','text','value','url','photo','iframe'],
 advertisingConsent:{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'},
 verification:'Preview, consent review, explicit publish, then DebugView and Realtime; configuration is not receipt evidence.'
} as const;
