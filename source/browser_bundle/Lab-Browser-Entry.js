/**
 * Lab-Browser-Entry
 *
 * Browserify entry point.  Quack builds this file into
 * `web/dist/ultravisor-lab.min.js`, which index.html loads as a standalone
 * library exposed at `window.UltravisorLab`.
 *
 * The HTML page instantiates Pict with `UltravisorLab.pict_configuration`
 * and then registers the application class + default configuration.
 *
 *   _Pict = new Pict(window.UltravisorLab.pict_configuration);
 *   _Pict.addApplication('UltravisorLab', UltravisorLab.default_configuration, UltravisorLab);
 *   _Pict.PictApplication.initializeAsync(fDone);
 */
'use strict';

const libLabApplication = require('./Lab-Browser-Application.js');

// Re-export: the default_configuration and pict_configuration ride on the
// application class itself (matching the pattern in pict-application
// example_applications/postcard_example).
module.exports = libLabApplication;

module.exports.default_configuration =
{
	Name:                       'Ultravisor-Lab',
	Hash:                       'UltravisorLab',
	MainViewportViewIdentifier: 'Lab-Navigation',
	AutoLoginAfterInitialize:   true,
	AutoLoadDataAfterLogin:     true
};

module.exports.pict_configuration =
{
	Product:      'Ultravisor-Lab',
	LogNoisiness: 2
};
