import {isApproved} from './domain.mjs';
// Publish the agreed development contract before implementation/testing.
// A supplied obsolete run must never trigger publishing another version.
export function canPublishAutomatically(feature,report) {
  return Boolean(feature && !feature.demo && isApproved(feature.spec) && (!report || report.featureId===feature.id && report.specDigest===feature.spec.approval.digest));
}
