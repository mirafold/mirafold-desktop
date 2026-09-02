## Included versions

- Mirafold Desktop `0.3.13`
- Mirafold Shell `0.8.3`

Desktop 0.3.13 is a forward-only security maintenance release. It keeps the
same Desktop and Shell behavior as 0.3.12 while replacing vulnerable
transitive dependencies before new packages are built.

## What changed

- The packaged runtime now contains `qs` 6.16.0, fixing two denial-of-service
  vulnerabilities in the prior 6.15.3 release.
- The packaged runtime now contains `fast-uri` 3.1.7, fixing four high-severity
  host-confusion and server-side request-forgery vulnerabilities in the prior
  3.1.5 release.
- The release build toolchain now uses `@xmldom/xmldom` 0.8.15, fixing an XML
  fragment-injection vulnerability in the prior 0.8.13 release.
- Manual releases now stop before dependency code or native builds unless the
  release notes contain one unambiguous included-versions section that exactly
  matches the Desktop and bundled Shell package versions.

- `qs` array-limit advisory: https://github.com/advisories/GHSA-x5fp-wj9c-mxmx
- `qs` buffer-detection advisory: https://github.com/advisories/GHSA-4mjr-xmp4-gh2g
- `fast-uri` IDN advisory: https://github.com/advisories/GHSA-5jgf-p345-68v8
- `fast-uri` IPv6 advisory: https://github.com/advisories/GHSA-f65p-4m7j-42xc
- `fast-uri` repeated-decoding advisory: https://github.com/advisories/GHSA-fph4-wmhf-6fwf
- `fast-uri` scheme advisory: https://github.com/advisories/GHSA-jqff-g426-hqxp
- `@xmldom/xmldom` advisory: https://github.com/advisories/GHSA-6gmq-8vp8-gcm6
- Bundled Shell release: https://github.com/mirafold/mirafold/releases/tag/v0.8.3
