import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Highly Optimized',
    Svg: require('@site/static/img/undraw_docusaurus_mountain.svg').default,
    description: (
      <>
        Designed with high performance in mind, our 
        <strong> Virtualized Lists</strong> architecture handles tens of thousands 
        of messages without lagging, mirroring native app performance.
      </>
    ),
  },
  {
    title: 'Limitless Customization',
    Svg: require('@site/static/img/undraw_docusaurus_tree.svg').default,
    description: (
      <>
        Take absolute control of the UI logic with 19+ powerful <code>Custom Hooks</code>. 
        Override or completely replace any component with your own interface layer seamlessly.
      </>
    ),
  },
  {
    title: 'Real-time Synchronization',
    Svg: require('@site/static/img/undraw_docusaurus_react.svg').default,
    description: (
      <>
        Integrated deeply with the <strong>Ermis SDK</strong> to capture and render 
        Socket Events instantly. Show active typing indicators, presence 
        states, and read receipts flawlessly.
      </>
    ),
  },
];

function Feature({title, Svg, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
