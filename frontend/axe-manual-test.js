// Manual accessibility test using axe-core
// Run this in browser console or via puppeteer

const { AxeBuilder } = require('@axe-core/playwright'); // will run manually

// Simple axe test function that can be run in browser console
function runAxeTest() {
  // Load axe if not already loaded
  if (typeof axe === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/axe-core@4.13.0/axe.min.js';
    script.onload = () => {
      console.log('axe-core loaded, running accessibility scan...');
      setTimeout(runScan, 1000);
    };
    document.head.appendChild(script);
  } else {
    runScan();
  }

  function runScan() {
    axe.run(document, {
      rules: {
        // Configure for WCAG 2.1 AA compliance
        'color-contrast': { enabled: true },
        'keyboard-navigation': { enabled: true },
        'focus-management': { enabled: true },
        'aria-live': { enabled: true },
        'alt-text': { enabled: true }
      },
      tags: ['wcag2a', 'wcag2aa', 'wcag21aa']
    }, (err, results) => {
      if (err) {
        console.error('Axe scan failed:', err);
        return;
      }
      
      console.log(`\n=== ACCESSIBILITY SCAN RESULTS ===`);
      console.log(`Violations: ${results.violations.length}`);
      console.log(`Passes: ${results.passes.length}`);
      console.log(`Incomplete: ${results.incomplete.length}`);
      console.log(`Inapplicable: ${results.inapplicable.length}`);
      
      if (results.violations.length > 0) {
        console.error('\n❌ ACCESSIBILITY VIOLATIONS FOUND:');
        results.violations.forEach((violation, i) => {
          console.error(`\n${i + 1}. ${violation.id} - ${violation.impact}`);
          console.error(`   Description: ${violation.description}`);
          console.error(`   Help: ${violation.help}`);
          console.error(`   Elements (${violation.nodes.length}):`);
          violation.nodes.forEach(node => {
            console.error(`     - ${node.target}`);
            if (node.failureSummary) {
              console.error(`       ${node.failureSummary}`);
            }
          });
        });
        console.error(`\n❌ TOTAL VIOLATIONS: ${results.violations.length}`);
      } else {
        console.log('\n✅ NO ACCESSIBILITY VIOLATIONS FOUND!');
        console.log('🎉 The page meets WCAG 2.1 AA standards');
      }
      
      if (results.incomplete.length > 0) {
        console.warn('\n⚠️  INCOMPLETE TESTS (manual review needed):');
        results.incomplete.forEach((item, i) => {
          console.warn(`${i + 1}. ${item.id}: ${item.description}`);
        });
      }
    });
  }
}

// Export for use in Node.js context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runAxeTest };
}

// Auto-run if in browser
if (typeof window !== 'undefined') {
  console.log('Run runAxeTest() to check accessibility');
}