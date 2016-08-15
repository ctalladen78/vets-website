// Builds the site using Metalsmith as the top-level build runner.

const Metalsmith = require('metalsmith');
const archive = require('metalsmith-archive');
const assets = require('metalsmith-assets');
const blc = require('metalsmith-broken-link-checker');
const collections = require('metalsmith-collections');
const commandLineArgs = require('command-line-args')
const dateInFilename = require('metalsmith-date-in-filename');
const define = require('metalsmith-define');
const excerpts = require('metalsmith-excerpts');
const filenames = require('metalsmith-filenames');
const ignore = require('metalsmith-ignore');
const inPlace = require('metalsmith-in-place');
const layouts = require('metalsmith-layouts');
const markdown = require('metalsmith-markdownit');
const navigation = require('metalsmith-navigation');
const permalinks = require('metalsmith-permalinks');
const sitemap = require('metalsmith-sitemap');
const watch = require('metalsmith-watch');
const webpack = require('metalsmith-webpack');
const webpackConfigGenerator = require('../config/webpack.config');
const webpackDevServer = require('metalsmith-webpack-dev-server');

const sourceDir = '../content/pages';

const smith = Metalsmith(__dirname);

const optionDefinitions = [
  { name: 'watch', type: Boolean, defaultValue: false },
  { name: 'port', type: Number, defaultValue: 3000 },
  { name: 'buildtype', type: String, defaultValue: 'development' },
  { name: 'no-sanity-check-node-env', type: Boolean, defaultValue: false },

  // Catch-all for bad arguments.
  { name: 'unexpected', type: String, multile: true, defaultOption: true },
];
const options = commandLineArgs(optionDefinitions);

const env = require('get-env')();

if (options.unexpected && options.unexpected.length !== 0) {
    throw new Error(`Unexpected arguments: '${options.unexpected}'`);
}

if (options.buildtype === undefined) {
  options.buildtype = 'development';
}

switch (options.buildtype) {
  case 'development':
    // No extra checks needed in dev.
    break;

  case 'production':
    if (options['no-sanity-check-node-env'] === false) {
      if (env != 'prod') {
        throw new Error(`buildtype ${options.buildtype} expects NODE_ENV to be production, not '${process.env.NODE_ENV}'`);
      }
    }
    break;

  default:
    throw new Error(`Unknown buildtype: '${options.buildtype}'`);
}

const webpackConfig = webpackConfigGenerator(options);

/////
// Set up Metalsmith. BE CAREFUL if you change the order of the plugins. Read the comments and
// add comments about any implicit dependencies you are introducing!!!
//

smith.source(sourceDir);
smith.destination(`../build/${options.buildtype}`);

// Ignore files that aren't ready for production.
// TODO(awong): Verify that memorial-benefits should still be in the source tree.
//    https://github.com/department-of-veterans-affairs/vets-website/issues/2721
const ignoreList = [ 'memorial-benefits/*' ];
if (options.buildtype === 'production') {
  ignoreList.push('rx/*');
}
smith.use(ignore(ignoreList));

// This adds the filename into the "entry" that is passed to other plugins. Without this errors
// during templating end up not showing which file they came from. Load it very early in in the
// plugin chain.
smith.use(filenames());

smith.use(define({
  // Does anything even look at `site`?
  site: require('../config/site'),
  buildtype: options.buildtype
}));

smith.use(collections());
smith.use(dateInFilename(true));
smith.use(archive());  // TODO(awong): Can this be removed?

// Liquid substitution must occur before markdown is run otherwise markdown will escape the
// bits of liquid commands (eg., quotes) and break things.
//
// Unfortunately this must come before permalinks and navgation because of limitation in both
// modules regarding what files they understand. The consequence here is that liquid templates
// *within* a single file do NOT have access to the final path that they will be rendered under
// or any other metadata added by the permalinks() and navigation() filters.
//
// Thus far this has not been a problem because the only references to such paths are in the
// includes which are handled by the layout module. The layout module, luckily, can be run
// near the end of the filter chain and therefore has access to all the metadata.
//
// If this becomes a barrier in the future, permalinks should be patched to understand
// translating .md files which would allow inPlace() and markdown() to be moved under the
// permalinks() and navigation() filters making the variable stores uniform between inPlace()
// and layout().
smith.use(inPlace({ engine: 'liquid' }));
smith.use(markdown({
  typographer: true,
  html: true
}));

// Responsible for create permalink structure. Most commonly used change foo.md to foo/index.html.
//
// This must come before navigation module, otherwise breadcrunmbs will see the wrong URLs.
//
// It also must come AFTER the markdown() module because it only recognizes .html files. See
// comment above the inPlace() module for explanation of effects on the metadata().
smith.use(permalinks({
  relative: false,
  linksets: [{
    match: { collection: 'posts' },
    pattern: ':date/:slug.html'
  }]
}));

smith.use(navigation({
  navConfigs: {
    sortByNameFirst: true,
    breadcrumbProperty: 'breadcrumb_path',
    pathProperty: 'nav_path',
    includeDirs: true
  }, navSettings: {} }));

smith.use(assets({ source: '../assets', destination: './' }));

// TODO(awong): Remove the default layout. Having a default layout makes it impossible to
// write a bare HTML page and it is just less explicit.
//
// https://github.com/department-of-veterans-affairs/vets-website/issues/2713
smith.use(layouts({
  engine: 'liquid',
  'default': 'page-breadcrumbs.html',
  directory: '../content/layouts/',
  // Only apply layouts to markdown and html files.
  pattern: '**/*.{md,html}'
}));

// TODO(awong): This URL needs to change based on target environment.
smith.use(sitemap('http://www.vets.gov'));
// TODO(awong): Does anything even use the results of this plugin?

if (options.watch) {
  // TODO(awong): Enable live reload of metalsmith pages per instructions at
  //   https://www.npmjs.com/package/metalsmith-watch
  smith.use(watch());

  // If in watch mode, assume hot reloading for JS and use webpack devserver.
  smith.use(webpackDevServer(
    webpackConfig,
    {
      contentBase: `build/${options.buildtype}`,
      historyApiFallback: false,
      hot: true,
      port: options.port,
      publicPath: '/generated/',
      stats: { colors: true }
    }
  ));
} else {
  // Broken link checking does not work well with watch. It continually shows broken links
  // for permalink processed files. Only run outside of watch mode.
  smith.use(blc({
    allowRedirects: true,  // Don't require trailing slash for index.html links.
    warn: process.env.NODE_ENV !== 'production',
    allowRegex: new RegExp(
        [ '/disability-benefits/',
          '/disability-benefits/apply-for-benefits/',
          '/disability-benefits/learn/',
          '/disability-benefits/learn/eligibility/.*',
          '/employment/commitments',
          '/employment/employers',
          '/employment/employers/',
          '/employment/job-seekers/create-resume',
          '/employment/job-seekers/search-jobs',
          '/employment/job-seekers/skills-translator',
          '/employment/users/sign_in',
          '/gi-bill-comparison-tool/',
          '/gibill/',
          '/healthcare/apply/application',
          '/veterans-employment-center/',
          'Employment-Resources/', ].join('|'))
  }));

  smith.use(webpack(webpackConfig));
}

smith.build(function(err) {
    if (err) throw err;
    console.log('Build finished!');
  });